import type { Document, RenameDocumentInput, SaveDraftInput } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { createQueryClient } from '../queryClient';
import { DocumentView } from './DocumentView';

const fetchMock = vi.mocked(fetch);

const reply = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(structuredClone(body))),
  }) as unknown as Response;

/** The server's document. */
let server: Document;
/** How many of the next reads of the document answer what the server held when they arrived, but only at `releaseReads`. */
let lateReads: number;
let late: (() => void)[];

/** The API's rules for the draft, the versions and the title of one document. */
const fakeApi = (method: string, url: URL, body: unknown): Response => {
  const draft = server.draft!;
  if (method === 'GET' && url.pathname.endsWith('/revisions')) return reply(200, []);
  if (method === 'GET' && url.pathname.includes('/revisions/')) return reply(404, { statusCode: 404, message: 'x' });
  if (method === 'GET') return reply(200, server);
  if (method === 'PUT') {
    const input = body as SaveDraftInput;
    if (draft.content === input.content) return reply(200, draft);
    if (draft.draftVersion !== input.draftVersion) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft });
    }
    server = { ...server, draft: { ...draft, content: input.content, draftVersion: draft.draftVersion + 1 } };
    return reply(200, server.draft);
  }
  if (method === 'PATCH') {
    server = { ...server, title: (body as RenameDocumentInput).title };
    return reply(200, server);
  }
  // POST: a version of the draft.
  server = { ...server, revision: server.revision + 1, content: draft.content };
  server = { ...server, draft: { ...draft, baseRevision: server.revision } };
  return reply(200, server);
};

let queryClient: QueryClient;

const open = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DocumentView id="doc-1" onDeleted={() => {}} onGoBack={() => {}} onOpen={() => {}} />
    </QueryClientProvider>,
  );

const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const textField = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…');
const type = (value: string) => fireEvent.change(textField(), { target: { value } });
const cached = () => queryClient.getQueryData<Document>(queryKeys.document('doc-1'));

/** Reads the document again now; the server answers at once, its answer arrives only at `releaseReads`. */
const lateRead = async () => {
  lateReads = 1;
  void queryClient.invalidateQueries({ queryKey: queryKeys.document('doc-1'), exact: true });
  await elapse();
  expect(late).toHaveLength(1);
};

const releaseReads = async () => {
  for (const answer of late.splice(0)) answer();
  await elapse();
};

/** Leaves the document, its text saved, so that this tab drops its machine; then opens it again. */
const reopen = async () => {
  cleanup();
  await elapse();
  open();
  await elapse();
};

/** What this tab read when it opened the document: a draft written since the last version. */
const opened: Document = {
  id: 'doc-1',
  title: 'The lighthouse keeper',
  revision: 2,
  content: 'Once upon a tide.',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  draft: { content: 'Once upon a tide. At dusk.', draftVersion: 3, baseRevision: 2 },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  server = opened;
  lateReads = 0;
  late = [];
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  fetchMock.mockImplementation((input, init) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost');
    url.pathname = url.pathname.replace(/^\/api/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const answer = fakeApi(method, url, body);
    if (method === 'GET' && url.pathname === '/documents/doc-1' && lateReads > 0) {
      lateReads--;
      return new Promise<Response>((resolve) => late.push(() => resolve(answer)));
    }
    return Promise.resolve(answer);
  });
});

afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('A read answered late never puts older text back', () => {
  it('keeps the draft saved since, and a document opened again starts from it, saved', async () => {
    open();
    await elapse();
    await lateRead();
    type('Once upon a tide. At dusk. Night.');
    await elapse(1000);
    expect(server.draft).toMatchObject({ content: 'Once upon a tide. At dusk. Night.', draftVersion: 4 });

    await releaseReads();
    expect(cached()?.draft).toMatchObject({ content: 'Once upon a tide. At dusk. Night.', draftVersion: 4 });

    await reopen();
    expect(textField().value).toBe('Once upon a tide. At dusk. Night.');
    expect(screen.getByText('Draft saved · changed since revision 2')).toBeTruthy();
    // A text typed now goes on the draft the server holds: no conflict with this tab's own save.
    type('Once upon a tide. At dusk. Night. Stars.');
    await elapse(1000);
    expect(server.draft).toMatchObject({ content: 'Once upon a tide. At dusk. Night. Stars.', draftVersion: 5 });
    expect(screen.queryByText('Not saved · changed elsewhere')).toBeNull();
  });

  it('keeps the version saved since', async () => {
    open();
    await elapse();
    await lateRead();
    fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await elapse();
    expect(server.revision).toBe(3);

    await releaseReads();
    expect(cached()).toMatchObject({ revision: 3, content: 'Once upon a tide. At dusk.' });
    expect(screen.getByText('Saved · revision 3')).toBeTruthy();

    await reopen();
    expect(screen.getByText('Saved · revision 3')).toBeTruthy();
  });

  it('keeps the title a rename confirmed since', async () => {
    open();
    await elapse();
    await lateRead();
    fireEvent.change(screen.getByDisplayValue('The lighthouse keeper'), { target: { value: 'The keeper' } });
    await elapse(800);
    expect(server.title).toBe('The keeper');

    await releaseReads();
    expect(cached()?.title).toBe('The keeper');

    await reopen();
    expect(screen.getByDisplayValue('The keeper')).toBeTruthy();
  });
});
