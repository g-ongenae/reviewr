import type { Document, SaveDraftInput } from '@reviewr/shared';
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

/** The server's document; undefined once deleted. */
let server: Document | undefined;
/** Every request sent, as `METHOD path?query`. */
let requests: string[];
/** The DELETE request fails as if the server were unreachable. */
let deleteFails: boolean;
/** While set, draft saves wait for `answerHeld`. */
let holding: boolean;
let held: (() => void)[];

/** The API's rules for the draft and the delete of one document. */
const fakeApi = (method: string, url: URL, body: unknown): Response => {
  if (server === undefined) return reply(404, { statusCode: 404, message: 'Document doc-1 not found' });
  const draft = server.draft;
  if (draft === undefined) throw new Error('No draft');
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
  if (method === 'DELETE') {
    if (deleteFails) return reply(503);
    // A bare DELETE deletes, as the API does for builds made before the precondition.
    const seen = url.searchParams.has('revision');
    const revision = Number(url.searchParams.get('revision'));
    const draftVersion = Number(url.searchParams.get('draftVersion'));
    if (seen && (revision !== server.revision || draftVersion !== draft.draftVersion)) {
      return reply(409, {
        statusCode: 409,
        error: 'Conflict',
        message: 'Document was modified elsewhere',
        code: 'document_changed',
        revision: server.revision,
        draft,
      });
    }
    server = undefined;
    return reply(204);
  }
  throw new Error(`Unexpected ${method} ${url.pathname}`);
};

let queryClient: QueryClient;
const onDeleted = vi.fn();

const open = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DocumentView id="doc-1" onDeleted={onDeleted} onGoBack={() => {}} onOpen={() => {}} />
    </QueryClientProvider>,
  );

const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const textField = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…');
const type = (value: string) => fireEvent.change(textField(), { target: { value } });
const clickDelete = () => fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
const deletes = () => requests.filter((request) => request.startsWith('DELETE'));
const reads = () => requests.filter((request) => request === 'GET /documents/doc-1');
const notDeleted =
  'This document was changed elsewhere since this screen read it, so it was not deleted. Check its text, then delete it again if you still mean to.';

/** What this tab read when it opened the document. */
const opened: Document = {
  id: 'doc-1',
  title: 'The lighthouse keeper',
  revision: 2,
  content: 'Once upon a tide.',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  draft: { content: 'Once upon a tide.', draftVersion: 3, baseRevision: 2 },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  server = opened;
  requests = [];
  holding = false;
  held = [];
  deleteFails = false;
  onDeleted.mockReset();
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  queryClient.setQueryData(queryKeys.document('doc-1'), opened);
  fetchMock.mockImplementation((input, init) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push(`${method} ${url.pathname.replace(/^\/api/, '')}${url.search}`);
    if (holding && method === 'PUT') {
      return new Promise<Response>((resolve) => held.push(() => resolve(fakeApi(method, url, body))));
    }
    return Promise.resolve(fakeApi(method, url, body));
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

describe('Deleting a document as this screen saw it', () => {
  it('deletes nothing when the text was changed elsewhere, says so, and shows the text read again', async () => {
    open();
    // Another device wrote two pages after this tab read the document.
    server = { ...opened, draft: { content: 'Once upon a tide. Two more pages.', draftVersion: 4, baseRevision: 2 } };

    clickDelete();
    await elapse();

    expect(deletes()).toEqual(['DELETE /documents/doc-1?revision=2&draftVersion=3']);
    expect(server).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByText(notDeleted)).toBeTruthy();
    // Read again through the normal path: this tab had no unsaved text, so it now shows the other device's text.
    expect(reads().length).toBeGreaterThan(0);
    expect(textField().value).toBe('Once upon a tide. Two more pages.');

    // Having seen the text, the writer deletes again, and it goes through.
    clickDelete();
    await elapse();
    expect(deletes().at(-1)).toBe('DELETE /documents/doc-1?revision=2&draftVersion=4');
    expect(server).toBeUndefined();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('keeps the text typed here when a version was saved elsewhere since this screen read it', async () => {
    open();
    // Another device saved the same draft as a version: the head moved, the draft did not.
    server = { ...opened, revision: 3, draft: { ...opened.draft!, baseRevision: 3 } };
    type('Once upon a tide. Mine.');

    clickDelete();
    await elapse();

    // The text typed here was saved first, then the delete was refused for the head it had not seen.
    expect(deletes()).toEqual(['DELETE /documents/doc-1?revision=2&draftVersion=4']);
    expect(server?.draft?.content).toBe('Once upon a tide. Mine.');
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByText(notDeleted)).toBeTruthy();
    expect(reads().length).toBeGreaterThan(0);
    expect(textField().value).toBe('Once upon a tide. Mine.');
    expect(screen.getByText(/revision 3/)).toBeTruthy();
  });

  it('never refuses itself: a text typed just before the click is saved first, and the delete carries its version', async () => {
    open();
    type('Once upon a tide. One last line.');
    // The click comes before the autosave's debounce; the save it sends is held.
    holding = true;
    clickDelete();
    await elapse();
    expect(requests.filter((request) => !request.startsWith('GET'))).toEqual(['PUT /documents/doc-1/draft']);
    // Frozen until the answer: nothing can be typed after the confirmation.
    expect(textField().readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Save version' })).toHaveProperty('disabled', true);

    holding = false;
    for (const answer of held.splice(0)) answer();
    await elapse();

    expect(deletes()).toEqual(['DELETE /documents/doc-1?revision=2&draftVersion=4']);
    expect(server).toBeUndefined();
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(screen.queryByText(notDeleted)).toBeNull();
  });

  it('deletes nothing when the text on screen could not be saved first', async () => {
    open();
    type('Once upon a tide. Unsent.');
    fetchMock.mockImplementation((_input, init) => {
      requests.push(`${init?.method ?? 'GET'} (server unreachable)`);
      return Promise.resolve(reply(503));
    });

    clickDelete();
    await elapse();

    expect(deletes()).toEqual([]);
    expect(server).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByText(/^Not deleted: your text could not be saved first/)).toBeTruthy();
    expect(textField().value).toBe('Once upon a tide. Unsent.');
  });
  it('carries the head shown at the confirmation, even when a newer one is read before the held save answers', async () => {
    open();
    type('Once upon a tide. Evening.');
    holding = true;
    clickDelete();
    await elapse();
    // Another device saves the same text as a version, then as its draft; this tab reads the document meanwhile.
    server = {
      ...opened,
      revision: 3,
      content: 'Once upon a tide. Evening.',
      draft: { content: 'Once upon a tide. Evening.', draftVersion: 4, baseRevision: 3 },
    };
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.document('doc-1') }));
    await elapse();
    holding = false;
    for (const answer of held.splice(0)) answer();
    await elapse();

    expect(deletes()).toEqual(['DELETE /documents/doc-1?revision=2&draftVersion=4']);
    expect(server).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByText(notDeleted)).toBeTruthy();
    expect(textField().readOnly).toBe(false);
  });

  it('sends nothing while the text is in conflict, and says to resolve it first, above the conflict notice', async () => {
    open();
    server = { ...opened, draft: { content: 'Theirs.', draftVersion: 4, baseRevision: 2 } };
    type('Mine.');
    await elapse(1000);
    expect(screen.getByText('This text was also changed on another device.')).toBeTruthy();

    clickDelete();
    await elapse();

    expect(deletes()).toEqual([]);
    expect(
      screen.getByText(/^Not deleted: this document was changed on another device\. Resolve that first/),
    ).toBeTruthy();
    expect(screen.getByText('This text was also changed on another device.')).toBeTruthy();
    expect(textField().value).toBe('Mine.');
  });

  it('unfreezes and keeps everything when the delete cannot reach the server', async () => {
    open();
    deleteFails = true;

    clickDelete();
    await elapse();

    expect(deletes()).toHaveLength(1);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(textField().readOnly).toBe(false);
    expect(textField().value).toBe('Once upon a tide.');
  });
});
