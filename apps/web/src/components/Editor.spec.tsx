import type { Document, DocumentDraft, Revision, RevisionSummary } from '@reviewr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { createQueryClient } from '../queryClient';
import { DocumentView } from './DocumentView';

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
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(body)),
  }) as unknown as Response;

/** A response the test sends when it wants. */
const deferred = () => {
  let send: (response: Response) => void = () => {};
  const response = new Promise<Response>((resolve) => (send = resolve));
  return { response, send };
};

const draft = (content: string, draftVersion: number, baseRevision = 2): DocumentDraft => ({
  content,
  draftVersion,
  baseRevision,
});

const opened: Document = {
  id: 'doc-1',
  title: 'The lighthouse keeper',
  revision: 2,
  content: 'Once upon a tide.',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  draft: draft('Once upon a tide.', 3),
};

let calls: Call[];
/** Answers the requests that a test does not handle itself. */
let handle: (call: Call) => Response | Promise<Response>;

/** Accepts every draft, as the API does when nobody else writes. */
const acceptDrafts = (call: Call): Response => {
  if (call.method === 'PUT' && call.path.endsWith('/draft')) {
    const { content, draftVersion } = call.body as { content: string; draftVersion: number };
    return reply(200, draft(content, draftVersion + 1));
  }
  return reply(404, { statusCode: 404, message: 'Not found' });
};

const draftSaves = () => calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/draft'));

const renderEditor = (document: Document = opened) => {
  const queryClient = createQueryClient();
  // The document is in the cache, as when it is opened from the list: the editor shows it without a request.
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  queryClient.setQueryData(queryKeys.document(document.id), document);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DocumentView id={document.id} onDeleted={() => {}} onGoBack={() => {}} />
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
};

/** Lets `ms` go by, and every response and render that follows. */
const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

const textarea = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…');
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
const status = () => screen.getByRole('status').textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  calls = [];
  handle = acceptDrafts;
  fetchMock.mockImplementation((input, init) => {
    const call = {
      method: init?.method ?? 'GET',
      path: new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost').pathname.replace(
        /^\/api/,
        '',
      ),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    // The writing stats read past revisions on their own: leave them out of what the tests check.
    if (!call.path.includes('/revisions')) calls.push(call);
    return Promise.resolve(handle(call));
  });
});

afterEach(async () => {
  // Unmount while the fake server still answers: leaving the editor sends what is left.
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('Editor autosave', () => {
  it('opens on the draft, and saves it once the writer pauses', async () => {
    const { queryClient } = renderEditor({ ...opened, draft: draft('Once upon a tide, again.', 3) });
    expect(textarea().value).toBe('Once upon a tide, again.');
    expect(status()).toBe('Draft saved · changed since revision 2');

    type('Once upon a tide, again and again.');
    expect(status()).toBe('Unsaved changes');
    await elapse(999);
    expect(draftSaves()).toEqual([]);

    const pending = deferred();
    handle = () => pending.response;
    await elapse(1);
    expect(draftSaves().map((call) => call.body)).toEqual([
      { content: 'Once upon a tide, again and again.', draftVersion: 3 },
    ]);
    expect(status()).toBe('Saving…');

    pending.send(reply(200, draft('Once upon a tide, again and again.', 4)));
    await elapse();
    expect(status()).toBe('Draft saved · changed since revision 2');
    // Reopening the document shows the saved draft.
    expect(queryClient.getQueryData<Document>(queryKeys.document('doc-1'))?.draft).toEqual(
      draft('Once upon a tide, again and again.', 4),
    );
  });

  it('sends the text typed during a request right after it, on the version it returned', async () => {
    renderEditor();
    const first = deferred();
    handle = () => first.response;
    type('Once upon a tide');
    await elapse(1000);

    type('Once upon a tide, the keeper slept.');
    await elapse(5000);
    expect(draftSaves()).toHaveLength(1);

    handle = acceptDrafts;
    first.send(reply(200, draft('Once upon a tide', 4)));
    await elapse();
    expect(draftSaves().map((call) => call.body)).toEqual([
      { content: 'Once upon a tide', draftVersion: 3 },
      { content: 'Once upon a tide, the keeper slept.', draftVersion: 4 },
    ]);
    expect(status()).toBe('Draft saved · changed since revision 2');
  });

  it('retries a failed request and says so, without a blocking error', async () => {
    renderEditor();
    handle = () => reply(503);
    type('Once upon a tide, the keeper slept.');
    await elapse(1000);
    expect(status()).toBe('Not saved · retrying');
    expect(screen.queryByRole('alert')).toBeNull();

    handle = acceptDrafts;
    await elapse(1000);
    expect(draftSaves()).toHaveLength(2);
    expect(status()).toBe('Draft saved · changed since revision 2');
  });

  it('stops retrying when the document was deleted, and keeps the text on screen', async () => {
    renderEditor();
    handle = () => reply(404, { statusCode: 404, message: 'Document doc-1 not found' });
    type('Once upon a tide, the keeper slept.');
    await elapse(1000);

    expect(status()).toBe('Not saved');
    expect(screen.getByRole('alert').textContent).toContain('This document was deleted elsewhere');
    expect(textarea().value).toBe('Once upon a tide, the keeper slept.');

    type('Once upon a tide, the keeper slept. The end.');
    await elapse(60_000);
    expect(draftSaves()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save version' })).toHaveProperty('disabled', true);
  });

  describe('when the draft was changed on another device', () => {
    const theirs = draft('Once upon a time, on another device.', 7);
    const mine = 'Once upon a tide, on this device.';

    const conflict = async () => {
      renderEditor();
      handle = (call) =>
        call.path.endsWith('/draft')
          ? reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft: theirs })
          : reply(404);
      type(mine);
      await elapse(1000);
      expect(status()).toBe('Not saved · changed elsewhere');
      expect(screen.getByRole('alert').textContent).toContain('This text was also changed on another device.');
    };

    it('"Discard mine" takes the other text and sends nothing', async () => {
      await conflict();
      fireEvent.click(screen.getByRole('button', { name: 'Discard mine, use the other text' }));
      await elapse(5000);

      expect(textarea().value).toBe(theirs.content);
      expect(status()).toBe('Draft saved · changed since revision 2');
      expect(draftSaves()).toHaveLength(1);
    });

    it('"Keep mine" saves the other text as a version first, then the local text on top of it', async () => {
      await conflict();
      const promoted: Document = {
        ...opened,
        revision: 3,
        content: theirs.content,
        draft: draft(theirs.content, 7, 3),
      };
      handle = (call) => {
        if (call.method === 'GET' && call.path === '/documents/doc-1') return reply(200, { ...opened, draft: theirs });
        if (call.method === 'PUT' && call.path === '/documents/doc-1') return reply(200, promoted);
        return acceptDrafts(call);
      };
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine, save the other as a version' }));
      await elapse();

      expect(calls.slice(1).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: 'GET', path: '/documents/doc-1', body: undefined },
        {
          method: 'PUT',
          path: '/documents/doc-1',
          body: { title: 'The lighthouse keeper', content: theirs.content, baseRevision: 2 },
        },
        { method: 'PUT', path: '/documents/doc-1/draft', body: { content: mine, draftVersion: 7 } },
      ]);
      expect(textarea().value).toBe(mine);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(status()).toBe('Draft saved · changed since revision 3');
    });
  });

  it('"Save version" saves the draft first, then creates the version from it', async () => {
    renderEditor();
    handle = (call) =>
      call.method === 'PUT' && call.path === '/documents/doc-1'
        ? reply(200, { ...opened, revision: 3, content: 'The end.', draft: draft('The end.', 4, 3) })
        : acceptDrafts(call);
    type('The end.');
    fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
    await elapse();

    expect(calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PUT', path: '/documents/doc-1/draft', body: { content: 'The end.', draftVersion: 3 } },
      {
        method: 'PUT',
        path: '/documents/doc-1',
        body: { title: 'The lighthouse keeper', content: 'The end.', baseRevision: 2 },
      },
    ]);
    expect(status()).toBe('Saved · revision 3');
  });

  it('Ctrl+S does not create a version when the draft cannot be saved', async () => {
    renderEditor();
    handle = () => reply(503);
    type('The end.');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await elapse();

    expect(calls.map((call) => call.path)).toEqual(['/documents/doc-1/draft']);
    expect(status()).toBe('Not saved · retrying');
  });

  it('restores a revision into the editor as an edit of the draft', async () => {
    const summary: RevisionSummary = { documentId: 'doc-1', revision: 1, title: 'Keeper', createdAt: opened.createdAt };
    const revision: Revision = { ...summary, content: 'It was a dark tide.' };
    handle = (call) => {
      if (call.path === '/documents/doc-1/revisions') return reply(200, [summary]);
      if (call.path === '/documents/doc-1/revisions/1') return reply(200, revision);
      return acceptDrafts(call);
    };
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await elapse();
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }));
    await elapse();
    fireEvent.click(screen.getByRole('button', { name: 'Restore into editor' }));

    expect(textarea().value).toBe('It was a dark tide.');
    await elapse(1000);
    expect(draftSaves().map((call) => call.body)).toEqual([{ content: 'It was a dark tide.', draftVersion: 3 }]);
    expect(calls.filter((call) => call.method === 'PUT' && call.path === '/documents/doc-1')).toEqual([]);
  });

  describe('leaving inside the debounce window still saves', () => {
    it('when the editor is closed', async () => {
      const { unmount } = renderEditor();
      type('Once upon a tide, the keeper slept.');
      unmount();
      await elapse();
      expect(draftSaves().map((call) => call.body)).toEqual([
        { content: 'Once upon a tide, the keeper slept.', draftVersion: 3 },
      ]);
    });

    it('when the tab is hidden', async () => {
      renderEditor();
      type('Once upon a tide, the keeper slept.');
      const visibility = vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('hidden');
      fireEvent(window.document, new Event('visibilitychange'));
      await elapse();
      visibility.mockRestore();
      expect(draftSaves()).toHaveLength(1);
      expect(status()).toBe('Draft saved · changed since revision 2');
    });

    it('when the page is closed, and warns until the text is saved', () => {
      renderEditor();
      type('Once upon a tide, the keeper slept.');
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(draftSaves()).toHaveLength(1);
    });
  });
});
