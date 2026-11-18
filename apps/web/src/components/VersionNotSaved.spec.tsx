import type { CreateRevisionInput, Document, SaveDraftInput } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { useAutosaveGuard } from '../autosave/useAutosave';
import { createQueryClient } from '../queryClient';
import { DocumentView } from './DocumentView';

const fetchMock = vi.mocked(fetch);

const reply = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(structuredClone(body))),
  }) as unknown as Response;

let document: Document;
let versions: [string | null, string][];
/** Answers a request instead of the server while it returns a response: 503 for an unreachable server. */
let fail: (method: string, path: string) => Response | undefined;
/** While set, requests wait for `answerHeld`. */
let holding: boolean;
let held: (() => void)[];
const answerHeld = async () => {
  holding = false;
  for (const answer of held.splice(0)) answer();
  await elapse();
};

/** The API's rules for the draft and the revisions of one document. */
const fakeApi = (method: string, path: string, body: unknown): Response => {
  const { draft } = document;
  if (draft === undefined) throw new Error('No draft');
  if (method === 'GET' && path.endsWith('/revisions')) return reply(200, []);
  if (method === 'GET') return reply(200, document);
  if (method === 'PUT') {
    const input = body as SaveDraftInput;
    if (draft.content === input.content) return reply(200, draft);
    if (draft.draftVersion !== input.draftVersion) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft });
    }
    document = { ...document, draft: { ...draft, content: input.content, draftVersion: draft.draftVersion + 1 } };
    return reply(200, document.draft);
  }
  const input = body as CreateRevisionInput;
  document = { ...document, revision: document.revision + 1, content: draft.content };
  versions.push([input.name ?? null, draft.content]);
  return reply(200, document);
};

let queryClient: QueryClient;

const Harness = () => {
  useAutosaveGuard();
  return <DocumentView id="doc-1" onDeleted={() => {}} onGoBack={() => {}} onOpen={() => {}} />;
};

const open = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );

const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const type = (value: string) => fireEvent.change(screen.getByPlaceholderText('Start writing…'), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Save version' });
const unreachableNotice =
  'Version not saved: the server is unreachable. Your text is kept; save the version again once it is back.';
const notice = () => screen.queryByText(/^Version not saved/)?.textContent;
const down = () => {
  fail = () => reply(503);
};
const back = () => {
  fail = () => undefined;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  const content = 'Once upon a tide.';
  document = {
    id: 'doc-1',
    title: 'The lighthouse keeper',
    revision: 2,
    content,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    draft: { content, draftVersion: 3, baseRevision: 2 },
  };
  versions = [];
  holding = false;
  held = [];
  back();
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  queryClient.setQueryData(queryKeys.document('doc-1'), document);
  fetchMock.mockImplementation((input, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost').pathname;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const answer = () => fail(method, path) ?? fakeApi(method, path, body);
    if (holding) return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
    return Promise.resolve(answer());
  });
});

afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('"Save version" when the draft cannot be saved first', () => {
  it('says the version was not saved while the server is unreachable, and saves it on the next try once it is back', async () => {
    open();
    down();
    type('Once upon a tide. The keeper woke.');
    fireEvent.click(saveButton());
    await elapse();
    expect(notice()).toBe(unreachableNotice);
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('Not saved · retrying');
    expect(versions).toEqual([]);

    // Saving again while it is still unreachable says so again.
    fireEvent.click(saveButton());
    await elapse();
    expect(notice()).toBe(unreachableNotice);

    back();
    holding = true;
    fireEvent.click(saveButton());
    await elapse();
    // The message goes as soon as the writer tries again.
    expect(notice()).toBeUndefined();
    await answerHeld();
    await elapse();
    expect(versions).toEqual([[null, 'Once upon a tide. The keeper woke.']]);
    expect(notice()).toBeUndefined();
  });

  it('Ctrl+S says so too', async () => {
    open();
    down();
    type('Once upon a tide. The keeper woke.');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await elapse();
    expect(notice()).toBe(unreachableNotice);
  });

  it('keeps the name field open with its name, so the next try saves the version with it', async () => {
    open();
    down();
    type('Once upon a tide. The keeper woke.');
    fireEvent.click(screen.getByRole('button', { name: 'Name this version' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Version name' }), { target: { value: 'Dawn' } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Version name' }));
    await elapse();
    expect(notice()).toBe(unreachableNotice);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Version name' }).value).toBe('Dawn');

    back();
    fireEvent.submit(screen.getByRole('textbox', { name: 'Version name' }));
    await elapse();
    expect(versions).toEqual([['Dawn', 'Once upon a tide. The keeper woke.']]);
    expect(screen.queryByRole('textbox', { name: 'Version name' })).toBeNull();
    expect(notice()).toBeUndefined();
  });

  it('says why when the server answers with an error the autosave retries', async () => {
    open();
    fail = (method) => (method === 'PUT' ? reply(500, { statusCode: 500, message: 'Database is down' }) : undefined);
    type('Once upon a tide. The keeper woke.');
    fireEvent.click(saveButton());
    await elapse();
    expect(notice()).toBe(
      'Version not saved: your text could not be saved first (Database is down). It is kept and saved again on its own; save the version again once it is saved.',
    );
  });

  it('shows no such message for a draft changed elsewhere: it has its own', async () => {
    open();
    document = { ...document, draft: { content: 'Theirs.', draftVersion: 4, baseRevision: 2 } };
    type('Mine.');
    fireEvent.click(saveButton());
    await elapse();
    expect(screen.getByRole('alert').textContent).toContain('This text was also changed on another device.');
    expect(notice()).toBeUndefined();
  });

  it('shows no such message for a refused text: it has its own', async () => {
    open();
    fail = (method) => (method === 'PUT' ? reply(413, { statusCode: 413, message: 'Too large' }) : undefined);
    type('Once upon a tide. And a very long text.');
    fireEvent.click(saveButton());
    await elapse();
    expect(screen.getByRole('alert').textContent).toContain('The server refused this text');
    expect(notice()).toBeUndefined();
  });
});
