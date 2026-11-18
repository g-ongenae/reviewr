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
/** Every request sent but reads, as `METHOD path?query`. */
let writes: string[];
/** Requests of these methods wait for `release`. */
let holding: Set<string>;
let held: (() => void)[];
/** The DELETE fails as if the server were unreachable. */
let deleteFails: boolean;

const release = async () => {
  holding.clear();
  for (const answer of held.splice(0)) answer();
  await elapse();
};

/** The API's rules for the draft, the versions and the delete of one document. */
const fakeApi = (method: string, url: URL, body: unknown): Response => {
  if (server === undefined) return reply(404, { statusCode: 404, message: 'Document doc-1 not found' });
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
  if (method === 'POST') {
    server = { ...server, revision: server.revision + 1, content: draft.content };
    server = { ...server, draft: { ...draft, baseRevision: server.revision } };
    return reply(200, server);
  }
  if (deleteFails) return reply(503);
  // A bare DELETE deletes, as the API does for builds made before the precondition.
  if (
    url.searchParams.has('revision') &&
    (Number(url.searchParams.get('revision')) !== server.revision ||
      Number(url.searchParams.get('draftVersion')) !== draft.draftVersion)
  ) {
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
};

let queryClient: QueryClient;
const onDeleted = vi.fn();
const confirm = vi.fn(() => true);

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
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save version' });
const deletes = () => writes.filter((request) => request.startsWith('DELETE'));
const notDeleted =
  'This document was changed elsewhere since this screen read it, so it was not deleted. Check its text, then delete it again if you still mean to.';

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
  confirm.mockReset().mockReturnValue(true);
  vi.spyOn(window, 'confirm').mockImplementation(confirm);
  server = opened;
  writes = [];
  holding = new Set();
  held = [];
  deleteFails = false;
  onDeleted.mockReset();
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  queryClient.setQueryData(queryKeys.document('doc-1'), opened);
  fetchMock.mockImplementation((input, init) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost');
    url.pathname = url.pathname.replace(/^\/api/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (method !== 'GET') writes.push(`${method} ${url.pathname}${url.search}`);
    if (holding.has(method)) {
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

describe('Deleting a document with the pair the screen showed', () => {
  it('deletes nothing when the text changed elsewhere, says so, reads it again, and deletes on a new confirmation', async () => {
    open();
    // Another device wrote more after this tab read the document; this tab has not read it yet.
    server = {
      ...opened,
      draft: { content: 'Once upon a tide. At dusk. Two pages.', draftVersion: 4, baseRevision: 2 },
    };

    clickDelete();
    await elapse();

    expect(deletes()).toEqual(['DELETE /documents/doc-1?revision=2&draftVersion=3']);
    expect(server).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByText(notDeleted)).toBeTruthy();
    expect(textField().value).toBe('Once upon a tide. At dusk. Two pages.');
    expect(textField().readOnly).toBe(false);

    clickDelete();
    await elapse();
    expect(deletes().at(-1)).toBe('DELETE /documents/doc-1?revision=2&draftVersion=4');
    expect(server).toBeUndefined();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('carries the pair taken when the dialog opened, even when a read arrives while it is open', async () => {
    open();
    confirm.mockImplementation(() => {
      // While the writer reads the dialog, another device saves, and this tab reads it.
      server = { ...opened, draft: { ...opened.draft!, content: 'Once upon a tide. Evening.', draftVersion: 4 } };
      queryClient.setQueryData(queryKeys.document('doc-1'), server);
      return true;
    });

    clickDelete();
    await elapse();

    expect(deletes()).toEqual(['DELETE /documents/doc-1?revision=2&draftVersion=3']);
    expect(server).toBeDefined();
    expect(screen.getByText(notDeleted)).toBeTruthy();
  });

  it('freezes the editor until the answer, then deletes', async () => {
    open();
    holding.add('DELETE');

    clickDelete();
    await elapse();
    expect(textField().readOnly).toBe(true);
    expect(screen.getByDisplayValue('The lighthouse keeper')).toHaveProperty('readOnly', true);
    expect(saveButton().disabled).toBe(true);

    await release();
    expect(server).toBeUndefined();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it.each([
    ['text not saved yet', 'Not deleted: your text is not saved yet. Delete once it is saved.'],
    [
      'a version being saved',
      'Not deleted: a version, a merge or a restore is in progress. Delete once it has finished.',
    ],
  ])('asks nothing and sends nothing with %s', async (state, message) => {
    open();
    if (state === 'text not saved yet') type('Once upon a tide. At dusk. More.');
    else {
      holding.add('POST');
      fireEvent.click(saveButton());
      await elapse();
    }

    clickDelete();
    await elapse();

    expect(confirm).not.toHaveBeenCalled();
    expect(deletes()).toEqual([]);
    expect(screen.getByText(message)).toBeTruthy();
    // The version still running is not detached: it ends as usual.
    await release();
    if (state === 'a version being saved') expect(screen.getByText('Saved · revision 3')).toBeTruthy();
  });

  it('asks nothing in a conflict, and says so above the conflict notice', async () => {
    open();
    server = { ...opened, draft: { ...opened.draft!, content: 'Theirs.', draftVersion: 4 } };
    type('Mine.');
    await elapse(1000);

    clickDelete();
    await elapse();

    expect(confirm).not.toHaveBeenCalled();
    expect(deletes()).toEqual([]);
    expect(
      screen.getByText(/^Not deleted: this document was changed on another device\. Resolve that first/),
    ).toBeTruthy();
    expect(screen.getByText('This text was also changed on another device.')).toBeTruthy();
  });

  it('unfreezes and keeps everything when the delete cannot reach the server', async () => {
    open();
    deleteFails = true;

    clickDelete();
    await elapse();

    expect(deletes()).toHaveLength(1);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(textField().readOnly).toBe(false);
    expect(textField().value).toBe('Once upon a tide. At dusk.');
  });
});
