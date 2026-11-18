import type { CreateRevisionInput, Document, Revision, SaveDraftInput } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { useAutosaveGuard } from '../autosave/useAutosave';
import { createQueryClient } from '../queryClient';
import { DocumentView } from './DocumentView';

const fetchMock = vi.mocked(fetch);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const reply = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(structuredClone(body))),
  }) as unknown as Response;

const fresh = (id: string, content: string): Document => ({
  id,
  title: 'The lighthouse keeper',
  revision: 2,
  content,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  draft: { content, draftVersion: 3, baseRevision: 2 },
});

let db: Map<string, Document>;
let revisions: Revision[];
let calls: Call[];
/** While true, every request fails as if the server were unreachable (a 503 from the proxy). */
let down: boolean;
/** Requests matching `holding` wait until `release`, then get the API's answer at that time. */
let holding: (call: Call) => boolean;
let waiting: (() => void)[];

const draftConflict = (draft: Document['draft']) =>
  reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft });

/** The API's rules for the draft and the revisions. */
const fakeApi = ({ method, path, body }: Call): Response => {
  const [, , id, sub] = path.split('/');
  const document = id === undefined ? undefined : db.get(id);
  if (document?.draft === undefined) return reply(404, { statusCode: 404, message: 'Not found' });
  const { draft } = document;
  if (method === 'GET' && sub === undefined) return reply(200, document);
  if (method === 'PUT' && sub === 'draft') {
    const input = body as SaveDraftInput;
    if (draft.content === input.content) return reply(200, draft);
    if (draft.draftVersion !== input.draftVersion) return draftConflict(draft);
    const saved = { ...draft, content: input.content, draftVersion: draft.draftVersion + 1 };
    db.set(document.id, { ...document, draft: saved });
    return reply(200, saved);
  }
  if (method === 'POST' && sub === 'revisions') {
    const input = body as CreateRevisionInput;
    if (draft.draftVersion !== input.draftVersion) return draftConflict(draft);
    if (draft.content === document.content) return reply(200, document);
    if (document.revision !== (input.baseRevision ?? 0)) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'stale_revision', revision: document.revision });
    }
    const next: Document = {
      ...document,
      revision: document.revision + 1,
      content: draft.content,
      draft: { ...draft, baseRevision: document.revision + 1 },
    };
    db.set(document.id, next);
    revisions.push({
      documentId: document.id,
      revision: next.revision,
      title: document.title,
      name: input.name ?? null,
      content: draft.content,
      createdAt: next.updatedAt,
    });
    return reply(200, next);
  }
  if (method === 'PATCH' && sub === 'revisions') {
    const revision = revisions.find((item) => item.revision === Number(path.split('/')[4]));
    if (revision === undefined) return reply(404, { statusCode: 404, message: 'Not found' });
    revision.name = (body as { name: string | null }).name;
    return reply(200, revision);
  }
  return reply(404, { statusCode: 404, message: 'Not found' });
};

const server = (id = 'doc-1') => {
  const document = db.get(id);
  if (document === undefined) throw new Error(`No ${id} on the server`);
  return document;
};

/** Another device saves a draft. */
const otherDraft = (content: string) => {
  const document = server();
  const draft = document.draft ?? { content: document.content, draftVersion: 1, baseRevision: null };
  db.set(document.id, { ...document, draft: { ...draft, content, draftVersion: draft.draftVersion + 1 } });
};

const Harness = ({ id }: { id: string }) => {
  useAutosaveGuard();
  return <DocumentView key={id} id={id} onDeleted={() => {}} onGoBack={() => {}} onOpen={() => {}} />;
};

let queryClient: QueryClient;
let rerender: ((id: string) => void) | undefined;

const open = (id = 'doc-1') => {
  if (rerender !== undefined) return rerender(id);
  const wrap = (next: string) => (
    <QueryClientProvider client={queryClient}>
      <Harness id={next} />
    </QueryClientProvider>
  );
  const view = render(wrap(id));
  rerender = (next) => view.rerender(wrap(next));
};

const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
/** Answers the requests held, and those they lead to, until none is left. */
const release = async () => {
  holding = () => false;
  while (waiting.length > 0) {
    for (const answer of waiting.splice(0)) answer();
    await elapse();
  }
};
const textarea = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…');
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
const status = () => screen.getAllByRole('status')[0]?.textContent;
const saveButton = () => screen.getByRole('button', { name: 'Save version' });
const versions = () => revisions.map(({ name, content }) => [name, content]);
const unload = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
};
/** "Save version" with a name, through the name field. */
const saveNamed = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Name this version' }));
  const field = screen.getByRole('textbox', { name: 'Version name' });
  fireEvent.change(field, { target: { value: name } });
  fireEvent.submit(field);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  db = new Map([fresh('doc-1', 'Once upon a tide.'), fresh('doc-2', 'Dear sea,')].map((d) => [d.id, d]));
  revisions = [];
  calls = [];
  down = false;
  holding = () => false;
  waiting = [];
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  for (const document of db.values()) queryClient.setQueryData(queryKeys.document(document.id), document);
  rerender = undefined;
  fetchMock.mockImplementation((input, init) => {
    const call = {
      method: init?.method ?? 'GET',
      path: new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost').pathname.replace(
        /^\/api/,
        '',
      ),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    if (down) return Promise.resolve(reply(503));
    if (call.method === 'GET' && call.path.includes('/revisions')) return Promise.resolve(reply(200, []));
    calls.push(call);
    if (holding(call)) return new Promise<Response>((resolve) => waiting.push(() => resolve(fakeApi(call))));
    return Promise.resolve(fakeApi(call));
  });
});

afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('"Save version" while the server is unreachable', () => {
  it('queues each version with its text, and creates them in order once the server is back, then the draft', async () => {
    open();
    down = true;
    type('Once upon a tide. The keeper woke.');
    fireEvent.click(saveButton());
    await elapse();
    expect(status()).toBe('Version waiting for the server');
    expect(screen.queryByRole('alert')).toBeNull();

    // The writer keeps typing, and saves another version, named.
    type('Once upon a tide. The keeper woke, and sang.');
    saveNamed('Second');
    await elapse();
    expect(status()).toBe('2 versions waiting for the server');
    type('Once upon a tide. The keeper woke, and sang. The end.');
    // The same text saved again is the same version.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await elapse();
    type('Once upon a tide. The keeper woke, and sang. The end?');
    expect(status()).toBe('3 versions waiting for the server');
    expect(unload().defaultPrevented).toBe(true);
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);

    down = false;
    await elapse(30_000);
    expect(versions()).toEqual([
      [null, 'Once upon a tide. The keeper woke.'],
      ['Second', 'Once upon a tide. The keeper woke, and sang.'],
      [null, 'Once upon a tide. The keeper woke, and sang. The end.'],
    ]);
    expect(server().draft?.content).toBe('Once upon a tide. The keeper woke, and sang. The end?');
    expect(textarea().value).toBe('Once upon a tide. The keeper woke, and sang. The end?');
    expect(status()).toBe('Draft saved · changed since revision 5');
    expect(unload().defaultPrevented).toBe(false);
  });

  it('a version of the text the server already holds as the head makes no revision', async () => {
    open();
    down = true;
    type('Once upon a tide. More.');
    await elapse(1000);
    type('Once upon a tide.');
    // Back to the head: there is nothing to save as a version.
    expect(saveButton()).toHaveProperty('disabled', true);
    type('Once upon a tide. Again.');
    fireEvent.click(saveButton());
    await elapse();
    down = false;
    await elapse(30_000);
    expect(versions()).toEqual([[null, 'Once upon a tide. Again.']]);
  });

  it('keeps the queue when the writer leaves the document: it is sent in the background', async () => {
    open();
    down = true;
    type('Once upon a tide. Left behind.');
    fireEvent.click(saveButton());
    await elapse();
    open('doc-2');
    await elapse();

    down = false;
    await elapse(30_000);
    expect(versions()).toEqual([[null, 'Once upon a tide. Left behind.']]);
    expect(server().revision).toBe(3);

    open('doc-1');
    await elapse();
    expect(status()).toBe('Saved · revision 3');
  });

  it('a click while the queue is being sent keeps its own text, even when more is typed before it is sent', async () => {
    open();
    down = true;
    type('Once upon a tide. A.');
    fireEvent.click(saveButton());
    await elapse();
    type('Once upon a tide. A. B.');

    // The server is back, slowly: the first version is on its way when the writer saves another, then types on.
    down = false;
    holding = () => true;
    await elapse(30_000);
    expect(waiting.length).toBe(1);
    fireEvent.click(saveButton());
    type('Once upon a tide. A. B. C.');
    await release();
    await elapse(1000);

    expect(versions()).toEqual([
      [null, 'Once upon a tide. A.'],
      [null, 'Once upon a tide. A. B.'],
    ]);
    expect(server().draft?.content).toBe('Once upon a tide. A. B. C.');
    expect(status()).toBe('Draft saved · changed since revision 4');
  });

  it('a name given for a version whose requests are on their way is given to it once created', async () => {
    open();
    type('Once upon a tide. Named later.');
    holding = () => true;
    fireEvent.click(saveButton());
    await elapse();
    expect(status()).toBe('Saving version…');
    // The same text, now with a name, while its draft request is on its way.
    saveNamed('Named later');
    await release();
    await elapse();

    expect(versions()).toEqual([['Named later', 'Once upon a tide. Named later.']]);
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([{ name: 'Named later' }]);
    expect(status()).toBe('Saved · revision 3');
  });

  describe('when the draft was changed on another device meanwhile', () => {
    it('writes nothing over it: the version stays readable and copyable until discarded, and the text is a conflict', async () => {
      open();
      down = true;
      type('Once upon a tide. Mine.');
      saveNamed('Mine');
      await elapse();
      type('Once upon a tide. Mine, and more.');
      otherDraft('Once upon a tide. Theirs.');

      down = false;
      await elapse(30_000);
      expect(versions()).toEqual([]);
      expect(server().draft?.content).toBe('Once upon a tide. Theirs.');
      expect(screen.getByRole('alert').textContent).toContain('This text was also changed on another device.');
      expect(textarea().value).toBe('Once upon a tide. Mine, and more.');
      const held = screen.getByRole('region', { name: 'Version “Mine”, not saved' });
      expect(within(held).getByRole<HTMLTextAreaElement>('textbox').value).toBe('Once upon a tide. Mine.');
      expect(within(held).getByText(/changed on another device before this version could be created/)).toBeTruthy();
      expect(unload().defaultPrevented).toBe(true);

      // Leaving and coming back still shows it.
      open('doc-2');
      await elapse();
      open('doc-1');
      await elapse();
      fireEvent.click(
        within(screen.getByRole('region', { name: 'Version “Mine”, not saved' })).getByRole('button', {
          name: 'Discard: Version “Mine”, not saved',
        }),
      );
      expect(screen.queryByRole('region', { name: 'Version “Mine”, not saved' })).toBeNull();
    });
  });
});
