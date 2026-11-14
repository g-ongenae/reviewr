import type {
  CreateDraftDocumentInput,
  CreateRevisionInput,
  Document,
  DocumentSummary,
  RenameDocumentInput,
  SaveDraftInput,
} from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reachability } from '../api';
import { App } from '../App';
import { createQueryClient } from '../queryClient';

const fetchMock = vi.mocked(fetch);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A response the client can read without streams, so fake timers alone drive every test. */
const reply = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(structuredClone(body))),
  }) as unknown as Response;

const error = (status: number, message: string) => reply(status, { statusCode: status, message });

/** The server's documents, and the creations it recorded (id → body), kept after a document is deleted. */
let db: Map<string, Document>;
let creations: Map<string, string>;

/** The API's rules, `POST /documents` with a client id included: same id and body, the document as it is now. */
const fakeApi = ({ method, path, body }: Call): Response => {
  if (method === 'GET' && path === '/health') return reply(200, { status: 'ok' });
  if (method === 'GET' && path === '/documents') {
    const list: DocumentSummary[] = [...db.values()].map(({ id, title, revision, createdAt, updatedAt }) => ({
      id,
      title,
      revision,
      createdAt,
      updatedAt,
    }));
    return reply(200, list);
  }
  if (method === 'POST' && path === '/documents') {
    const input = body as CreateDraftDocumentInput;
    const key = JSON.stringify([input.title ?? null, input.content, input.draftOnly]);
    const recorded = creations.get(input.id);
    if (recorded !== undefined) {
      if (recorded !== key) return error(422, `Document ${input.id} was already created with another body`);
      const existing = db.get(input.id);
      return existing === undefined ? error(410, `Document ${input.id} was deleted`) : reply(201, existing);
    }
    creations.set(input.id, key);
    const now = new Date().toISOString();
    const created: Document = {
      id: input.id,
      title: input.title ?? null,
      revision: 0,
      content: '',
      createdAt: now,
      updatedAt: now,
      draft: { content: input.content, draftVersion: 1, baseRevision: null },
    };
    db.set(input.id, created);
    return reply(201, created);
  }

  const [, , id, sub] = path.split('/');
  const document = id === undefined ? undefined : db.get(id);
  if (document?.draft === undefined) return error(404, 'Not found');
  const { draft } = document;
  if (method === 'GET' && sub === undefined) return reply(200, document);
  if (method === 'PUT' && sub === 'draft') {
    const input = body as SaveDraftInput;
    if (draft.content === input.content) return reply(200, draft);
    if (draft.draftVersion !== input.draftVersion) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft });
    }
    const saved = { ...draft, content: input.content, draftVersion: draft.draftVersion + 1 };
    db.set(document.id, { ...document, draft: saved });
    return reply(200, saved);
  }
  if (method === 'POST' && sub === 'revisions') {
    const input = body as CreateRevisionInput;
    if (draft.draftVersion !== input.draftVersion) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft });
    }
    // The draft already is the head (an empty draft without a version too): nothing to save.
    if (draft.content === document.content) return reply(200, document);
    if (document.revision !== (input.baseRevision ?? 0)) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'stale_revision', revision: document.revision });
    }
    const revision = document.revision + 1;
    const next = { ...document, content: draft.content, revision, draft: { ...draft, baseRevision: revision } };
    db.set(document.id, next);
    return reply(200, next);
  }
  if (method === 'GET' && sub === 'revisions') return reply(200, []);
  if (method === 'PATCH' && sub === undefined) {
    const { title } = body as RenameDocumentInput;
    const renamed = { ...document, title: title?.trim() ? title : null };
    db.set(document.id, renamed);
    return reply(200, renamed);
  }
  return error(404, 'Not found');
};

let calls: Call[];
/** Answers a request instead of the fake API, when it returns a response. */
let intercept: (call: Call) => Response | undefined;
/** Requests matching `hold` wait until `releaseHeld`, then get the API's answer at that time. */
let hold: (call: Call) => boolean;
/** Requests matching `lose` reach the API, but their answer is lost: the client sees a network error. */
let lose: (call: Call) => boolean;
let held: (() => void)[];

/**
 * Lets `ms` go by, then 2 ms more, and every response and render that follows: the query cache tells its observers on
 * a 0 ms timer, which the fake clock runs only once it moves, and the address changes after that render.
 */
const elapse = async (ms = 0) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await act(() => vi.advanceTimersByTimeAsync(1));
  await act(() => vi.advanceTimersByTimeAsync(1));
};

const releaseHeld = async () => {
  hold = () => false;
  for (const answer of held.splice(0)) answer();
  await elapse();
};

const creates = () => calls.filter((call) => call.method === 'POST' && call.path === '/documents');
const draftSaves = () => calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/draft'));

let queryClient: QueryClient;

const start = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );

const textarea = () => {
  const field = document.querySelector('textarea');
  if (field === null) throw new Error('No text field');
  return field;
};
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
const titleField = () => {
  const field = document.querySelector<HTMLInputElement>('.title-input');
  if (field === null) throw new Error('No title field');
  return field;
};
/** The toolbar's status, the first on the page. */
const status = () => screen.getAllByRole('status')[0]?.textContent;
const unload = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
};
const only = <T,>(items: T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  db = new Map();
  const now = '2026-11-01T10:00:00.000Z';
  db.set('doc-1', {
    id: 'doc-1',
    title: 'Le gardien du phare',
    revision: 1,
    content: 'Il veillait.',
    createdAt: now,
    updatedAt: now,
    draft: { content: 'Il veillait.', draftVersion: 1, baseRevision: 1 },
  });
  creations = new Map();
  calls = [];
  intercept = () => undefined;
  hold = () => false;
  lose = () => false;
  held = [];
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false } });

  fetchMock.mockImplementation((input, init) => {
    const call = {
      method: init?.method ?? 'GET',
      path: new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost').pathname.replace(
        /^\/api/,
        '',
      ),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const answer = () => intercept(call) ?? fakeApi(call);
    if (lose(call)) {
      answer();
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (hold(call)) return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
    return Promise.resolve(answer());
  });
});

afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
  vi.restoreAllMocks();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('The blank page', () => {
  it('creates the document once the writer pauses, as a draft only, and takes its address', async () => {
    start();
    await elapse();
    const field = textarea();
    expect(document.activeElement).toBe(field);
    expect(screen.getByText('What do you want to tell today?')).toBeTruthy();

    type('Il était une fois un phare.');
    expect(status()).toBe('Unsaved changes');
    await elapse(997);
    expect(creates()).toEqual([]);
    await elapse(1);

    const { body } = only(creates());
    const { id } = body as CreateDraftDocumentInput;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body).toEqual({ id, content: 'Il était une fois un phare.', draftOnly: true });
    expect(db.get(id)).toMatchObject({ revision: 0, draft: { content: 'Il était une fois un phare.' } });
    expect(window.location.hash).toBe(`#/documents/${id}`);
    expect(status()).toBe('No version yet · draft saved');
    // The same text field, still focused: the page became the document without being rebuilt.
    expect(textarea()).toBe(field);
    expect(document.activeElement).toBe(field);
    // The document is listed.
    expect(screen.getAllByRole('button', { name: /^Untitled/ })).toHaveLength(1);

    // From then on, the text is autosaved as a draft.
    type('Il était une fois un phare. Son gardien dormait.');
    await elapse(1000);
    expect(only(draftSaves()).body).toEqual({
      content: 'Il était une fois un phare. Son gardien dormait.',
      draftVersion: 1,
    });
    expect(creates()).toHaveLength(1);
    expect(db.get(id)?.draft?.content).toBe('Il était une fois un phare. Son gardien dormait.');
  });

  it('keeps the caret, the selection and the text field through the creation', async () => {
    start();
    await elapse();
    const field = textarea();
    field.focus();
    hold = (call) => call.path === '/documents' && call.method === 'POST';
    type('Le phare');
    await elapse(1000);
    type('Le phare veillait');
    field.setSelectionRange(3, 8);
    // An IME composition in progress: the browser keeps it as long as the text field is the same element.
    fireEvent.compositionStart(field);

    await releaseHeld();
    await elapse(1000);
    expect(window.location.hash).toMatch(/^#\/documents\//);
    expect(textarea()).toBe(field);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 8]);
    expect(field.value).toBe('Le phare veillait');
    fireEvent.compositionEnd(field);
  });

  it('saves the text typed during the creation once the document exists, without sending anything twice', async () => {
    start();
    await elapse();
    hold = (call) => call.path === '/documents' && call.method === 'POST';
    type('Il était');
    await elapse(1000);
    type('Il était une fois');
    await elapse(5000);
    type('Il était une fois, au bord de la mer,');
    await elapse(5000);
    expect(creates()).toHaveLength(1);
    expect(draftSaves()).toEqual([]);
    expect(status()).toBe('Saving…');
    expect(unload().defaultPrevented).toBe(true);

    await releaseHeld();
    const { id } = only(creates()).body as CreateDraftDocumentInput;
    expect(only(draftSaves()).body).toEqual({ content: 'Il était une fois, au bord de la mer,', draftVersion: 1 });
    expect(db.size).toBe(2);
    expect(db.get(id)?.draft).toMatchObject({ content: 'Il était une fois, au bord de la mer,', draftVersion: 2 });
    expect(textarea().value).toBe('Il était une fois, au bord de la mer,');
    expect(status()).toBe('No version yet · draft saved');
    expect(unload().defaultPrevented).toBe(false);
  });

  it('sends the creation again unchanged after a lost answer, and makes one document', async () => {
    start();
    await elapse();
    lose = (call) => call.path === '/documents' && call.method === 'POST';
    type('Le gardien');
    await elapse(1000);
    lose = () => false;
    // The server has the document; the tab does not know it, and the writer goes on.
    expect(db.size).toBe(2);
    expect(status()).toBe('Not saved · retrying');
    expect(screen.queryByRole('alert')).toBeNull();
    type('Le gardien dormait.');
    await elapse(1000);

    const [first, second] = creates();
    expect(creates()).toHaveLength(2);
    expect(second?.body).toEqual(first?.body);
    expect((first?.body as CreateDraftDocumentInput).content).toBe('Le gardien');
    // The later text goes as a draft, on the version the creation answered.
    expect(only(draftSaves()).body).toEqual({ content: 'Le gardien dormait.', draftVersion: 1 });
    expect(db.size).toBe(2);
    expect(status()).toBe('No version yet · draft saved');
  });

  it('shows a conflict when another device changed the draft before a lost creation is sent again', async () => {
    start();
    await elapse();
    lose = (call) => call.path === '/documents' && call.method === 'POST';
    type('Le gardien');
    await elapse(1000);
    lose = () => false;
    const { id } = only(creates()).body as CreateDraftDocumentInput;
    // Another device opened the document and wrote over its draft meanwhile.
    const created = db.get(id);
    if (created?.draft === undefined) throw new Error('Not created');
    db.set(id, { ...created, draft: { ...created.draft, content: 'Le gardien du phare', draftVersion: 2 } });
    type('Le gardien dormait.');
    await elapse(1000);

    expect(creates()).toHaveLength(2);
    expect(draftSaves()).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('This text was also changed on another device.');
    expect(status()).toBe('Not saved · changed elsewhere');
    expect(textarea().value).toBe('Le gardien dormait.');
    expect(db.get(id)?.draft?.content).toBe('Le gardien du phare');
    expect(unload().defaultPrevented).toBe(true);
  });

  it('retries a failed creation with the same body, saying that the server is unreachable', async () => {
    start();
    await elapse();
    // The proxy answers for an unreachable server, to the health probe too.
    intercept = () => reply(503);
    type('La mer monte.');
    await elapse(1000);
    expect(status()).toBe('Not saved · retrying');
    expect(screen.getByText('Server unreachable')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    type('La mer monte. Le vent tourne.');
    await elapse(1000);
    expect(creates()).toHaveLength(2);

    intercept = () => undefined;
    await elapse(2000);
    expect(creates().map((call) => call.body)).toEqual(
      Array.from({ length: 3 }, () => ({
        id: expect.any(String) as string,
        content: 'La mer monte.',
        draftOnly: true,
      })),
    );
    expect(new Set(creates().map((call) => (call.body as CreateDraftDocumentInput).id)).size).toBe(1);
    expect(only(draftSaves()).body).toEqual({ content: 'La mer monte. Le vent tourne.', draftVersion: 1 });
    expect(status()).toBe('No version yet · draft saved');
  });

  it('creates nothing for an empty or blank page', async () => {
    start();
    await elapse(60_000);
    type('   \n ');
    await elapse(60_000);
    type('');
    await elapse(60_000);
    expect(creates()).toEqual([]);
    expect(unload().defaultPrevented).toBe(false);
    expect(screen.getByRole('button', { name: 'Save version' })).toHaveProperty('disabled', true);
    expect(window.location.hash).toBe('');
  });

  it('saves the first version as revision 1', async () => {
    start();
    await elapse();
    type('Il était une fois.');
    fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await elapse();

    const { id } = only(creates()).body as CreateDraftDocumentInput;
    const version = only(calls.filter((call) => call.path === `/documents/${id}/revisions` && call.method === 'POST'));
    expect(version.body).toEqual({ draftVersion: 1, baseRevision: null });
    expect(db.get(id)).toMatchObject({ revision: 1, content: 'Il était une fois.' });
    expect(status()).toBe('Saved · revision 1');
  });

  it('guards the text when leaving before or during the creation, and creates it in the background', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    start();
    await elapse();
    hold = (call) => call.path === '/documents' && call.method === 'POST';
    type('Une lettre à la mer.');
    // Before the creation: closing the page warns, and sends it at once.
    expect(unload().defaultPrevented).toBe(true);
    expect(creates()).toHaveLength(1);

    // Leaving is asked first; staying keeps the page as it is.
    fireEvent.click(screen.getByRole('button', { name: /Le gardien du phare/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('Une lettre à la mer.');
    await elapse(1000);
    expect(status()).toBe('Saving…');
    expect(unload().defaultPrevented).toBe(true);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Le gardien du phare/ }));
    await elapse();
    expect(window.location.hash).toBe('#/documents/doc-1');
    expect(textarea().value).toBe('Il veillait.');
    // The creation is still on its way: the text is still guarded.
    expect(unload().defaultPrevented).toBe(true);

    await releaseHeld();
    const { id } = only(creates()).body as CreateDraftDocumentInput;
    expect(db.get(id)?.draft?.content).toBe('Une lettre à la mer.');
    expect(unload().defaultPrevented).toBe(false);
    // The document is listed, and the address stays the one the writer chose.
    expect(screen.getAllByRole('button', { name: /^Untitled/ })).toHaveLength(1);
    expect(window.location.hash).toBe('#/documents/doc-1');

    // A new page is a new document, not the one just created.
    fireEvent.click(screen.getByRole('button', { name: '+ New document' }));
    await elapse();
    expect(textarea().value).toBe('');
    type('Une autre lettre.');
    await elapse(1000);
    expect(creates()).toHaveLength(2);
    expect((creates()[1]?.body as CreateDraftDocumentInput).id).not.toBe(id);
  });

  it('keeps the text of a page left before its creation was sent, on the blank page, until it is created', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    start();
    await elapse();
    intercept = (call) => (call.path === '/documents' && call.method === 'POST' ? reply(503) : undefined);
    type('Une lettre à la mer.');
    fireEvent.click(screen.getByRole('button', { name: /Le gardien du phare/ }));
    await elapse();
    // Leaving sent it at once; it is retried in the background.
    expect(creates()).toHaveLength(1);
    expect(unload().defaultPrevented).toBe(true);

    // Back on the blank page, the text is there.
    fireEvent.click(screen.getByRole('button', { name: '+ New document' }));
    await elapse();
    expect(textarea().value).toBe('Une lettre à la mer.');
    expect(status()).toBe('Not saved · retrying');
  });

  it.each([
    [410, 'Document was deleted'],
    [422, 'Document was already created with another body'],
  ])(
    'keeps the text and title after a %i on creation, without looping, and creates them again under a new id',
    async (code) => {
      start();
      await elapse();
      intercept = (call) =>
        call.path === '/documents' && call.method === 'POST' && creates().length === 1
          ? error(code, 'Refused')
          : undefined;
      fireEvent.change(titleField(), { target: { value: 'Le phare' } });
      type('Le phare est éteint.');
      await elapse(60_000);
      expect(creates()).toHaveLength(1);
      expect(screen.getByRole('alert').textContent).toBe(
        'This text could not be saved as a new document. It is kept here: try again to save it.Try again',
      );
      expect(textarea().value).toBe('Le phare est éteint.');
      expect(status()).toBe('Not saved');
      expect(unload().defaultPrevented).toBe(true);
      expect(window.location.hash).toBe('');

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await elapse();
      const [refused, again] = creates();
      expect(creates()).toHaveLength(2);
      const id = (again?.body as CreateDraftDocumentInput).id;
      expect(id).not.toBe((refused?.body as CreateDraftDocumentInput).id);
      expect(again?.body).toEqual({ id, content: 'Le phare est éteint.', draftOnly: true });
      expect(window.location.hash).toBe(`#/documents/${id}`);
      expect(textarea().value).toBe('Le phare est éteint.');
      // The title typed before the refusal is still there, and saved once the document exists.
      expect(titleField().value).toBe('Le phare');
      expect(status()).toBe('Saving title…');
      expect(unload().defaultPrevented).toBe(true);

      await elapse(1000);
      const rename = only(calls.filter((call) => call.method === 'PATCH'));
      expect(rename).toEqual({ method: 'PATCH', path: `/documents/${id}`, body: { title: 'Le phare' } });
      expect(db.get(id)?.title).toBe('Le phare');
      expect(status()).toBe('No version yet · draft saved');
      expect(unload().defaultPrevented).toBe(false);
    },
  );
});
