import type { CreateRevisionInput, Document, Revision, SaveDraftInput, UpdateDocumentInput } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { useAutosaveGuard } from '../autosave/useAutosave';
import { createQueryClient } from '../queryClient';
import { versionName } from '../reconcile/session';
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
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(structuredClone(body))),
  }) as unknown as Response;

const notFound = () => reply(404, { statusCode: 404, message: 'Not found' });

const fresh = (id: string, title: string, content: string): Document => ({
  id,
  title,
  revision: 2,
  content,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  draft: { content, draftVersion: 3, baseRevision: 2 },
});

/** The server's documents, mutated by the fake API below and by "another device". */
let db: Map<string, Document>;
let revisions: Revision[];

/** `appendRevision` of the API: a new head, the draft equal to it, its counter moved only if its text changed. */
const appendRevision = (
  document: Document,
  title: string | null,
  content: string,
  name: string | null = null,
): Document => {
  const draft = document.draft ?? { content: document.content, draftVersion: 1, baseRevision: null };
  const next: Document = {
    ...document,
    title,
    content,
    revision: document.revision + 1,
    draft: {
      content,
      draftVersion: draft.content === content ? draft.draftVersion : draft.draftVersion + 1,
      baseRevision: document.revision + 1,
    },
  };
  db.set(document.id, next);
  revisions.push({ documentId: document.id, revision: next.revision, title, name, content, createdAt: next.updatedAt });
  return next;
};

const staleRevision = (revision: number) =>
  reply(409, { statusCode: 409, message: 'Conflict', code: 'stale_revision', revision });

const draftConflict = (draft: Document['draft']) =>
  reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft });

/**
 * The API's rules for `GET /documents/:id`, `PUT /documents/:id/draft`, `PUT /documents/:id` and
 * `POST /documents/:id/revisions`.
 */
const fakeApi = ({ method, path, body }: Call): Response => {
  const [, , id, sub] = path.split('/');
  const document = id === undefined ? undefined : db.get(id);
  if (document?.draft === undefined) return notFound();
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
  if (method === 'PUT' && sub === undefined) {
    const input = body as UpdateDocumentInput;
    if (document.revision !== input.baseRevision) return staleRevision(document.revision);
    if (document.title === input.title && document.content === input.content) return reply(200, document);
    if (draft.content !== document.content && draft.content !== input.content) {
      return staleRevision(appendRevision(document, document.title, draft.content).revision);
    }
    return reply(200, appendRevision(document, input.title ?? null, input.content));
  }
  if (method === 'POST' && sub === 'revisions') {
    const input = body as CreateRevisionInput;
    if (draft.draftVersion !== input.draftVersion) return draftConflict(draft);
    if (draft.content === document.content) return reply(200, document);
    if (document.revision !== input.baseRevision) return staleRevision(document.revision);
    return reply(200, appendRevision(document, document.title, draft.content, input.name ?? null));
  }
  return notFound();
};

const server = (id = 'doc-1') => {
  const document = db.get(id);
  if (document === undefined) throw new Error(`No ${id} on the server`);
  return document;
};

/** Another device saves a draft. */
const otherDraft = (content: string, id = 'doc-1') => {
  const document = server(id);
  const draft = document.draft ?? { content: document.content, draftVersion: 1, baseRevision: null };
  db.set(id, { ...document, draft: { ...draft, content, draftVersion: draft.draftVersion + 1 } });
};

let calls: Call[];
/** Answers a request instead of the fake API, when it returns a response. */
let intercept: (call: Call) => Response | undefined;
/** Requests matching `hold` wait until `releaseHeld`, then get the API's answer at that time. */
let hold: (call: Call) => boolean;
/** Requests matching `delay` are handled by the API at once, but their answer arrives only at `releaseHeld`. */
let delay: (call: Call) => boolean;
let held: (() => void)[];

const releaseHeld = async () => {
  hold = () => false;
  delay = () => false;
  for (const answer of held.splice(0)) answer();
  await elapse();
};

const draftSaves = (id = 'doc-1') =>
  calls.filter((call) => call.method === 'PUT' && call.path === `/documents/${id}/draft`);

/** The app around the document view: one query client for the whole test, and the app-level unload guard. */
const Harness = ({ id }: { id: string }) => {
  useAutosaveGuard();
  return <DocumentView key={id} id={id} onDeleted={() => {}} onGoBack={() => {}} />;
};

let queryClient: QueryClient;
let rerender: ((id: string) => void) | undefined;

/** Opens a document, as selecting it in the list does; the cache already holds what the list loaded. */
const open = (id = 'doc-1') => {
  if (rerender === undefined) {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Harness id={id} />
      </QueryClientProvider>,
    );
    rerender = (next) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <Harness id={next} />
        </QueryClientProvider>,
      );
  } else {
    rerender(id);
  }
};

/** Lets `ms` go by, and every response and render that follows. */
const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

const textarea = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…');
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
/** The toolbar's status, the first on the page. */
const status = () => screen.getAllByRole('status')[0]?.textContent;
const unload = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  db = new Map(
    [
      fresh('doc-1', 'The lighthouse keeper', 'Once upon a tide.'),
      fresh('doc-2', 'Letters from the shore', 'Dear sea,'),
    ].map((document) => [document.id, document]),
  );
  revisions = [];
  calls = [];
  intercept = () => undefined;
  hold = () => false;
  delay = () => false;
  held = [];
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
    // The writing stats read past revisions on their own: leave them out of what the tests check.
    if (call.method === 'GET' && call.path.includes('/revisions'))
      return Promise.resolve(intercept(call) ?? reply(200, []));
    calls.push(call);
    const answer = () => intercept(call) ?? fakeApi(call);
    if (hold(call)) return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
    if (delay(call)) {
      const response = answer();
      return new Promise<Response>((resolve) => held.push(() => resolve(response)));
    }
    return Promise.resolve(answer());
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
    otherDraft('Once upon a tide, again.');
    queryClient.setQueryData(queryKeys.document('doc-1'), server());
    open();
    expect(textarea().value).toBe('Once upon a tide, again.');
    expect(status()).toBe('Draft saved · changed since revision 2');

    type('Once upon a tide, again and again.');
    expect(status()).toBe('Unsaved changes');
    await elapse(999);
    expect(draftSaves()).toEqual([]);

    hold = () => true;
    await elapse(1);
    expect(draftSaves().map((call) => call.body)).toEqual([
      { content: 'Once upon a tide, again and again.', draftVersion: 4 },
    ]);
    expect(status()).toBe('Saving…');

    await releaseHeld();
    expect(status()).toBe('Draft saved · changed since revision 2');
    expect(server().draft?.content).toBe('Once upon a tide, again and again.');
    expect(queryClient.getQueryData<Document>(queryKeys.document('doc-1'))?.draft).toEqual(server().draft);
  });

  it('sends the text typed during a request right after it, on the version it returned', async () => {
    open();
    hold = () => true;
    type('Once upon a tide');
    await elapse(1000);
    type('Once upon a tide, the keeper slept.');
    await elapse(5000);
    expect(draftSaves()).toHaveLength(1);

    await releaseHeld();
    expect(draftSaves().map((call) => call.body)).toEqual([
      { content: 'Once upon a tide', draftVersion: 3 },
      { content: 'Once upon a tide, the keeper slept.', draftVersion: 4 },
    ]);
    expect(status()).toBe('Draft saved · changed since revision 2');
    expect(server().draft?.content).toBe('Once upon a tide, the keeper slept.');
  });

  it('retries a failed request and says so, without a blocking error', async () => {
    open();
    intercept = (call) => (call.path.endsWith('/draft') ? reply(503) : undefined);
    type('Once upon a tide, the keeper slept.');
    await elapse(1000);
    expect(status()).toBe('Not saved · retrying');
    expect(screen.queryByRole('alert')).toBeNull();

    intercept = () => undefined;
    await elapse(1000);
    expect(draftSaves()).toHaveLength(2);
    expect(status()).toBe('Draft saved · changed since revision 2');
  });

  it('stops retrying when the document was deleted, and keeps the text on screen', async () => {
    open();
    db.delete('doc-1');
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

  it('does not resend a refused text, and saves it again once the writer changed it', async () => {
    open();
    intercept = (call) =>
      call.path.endsWith('/draft') && (call.body as SaveDraftInput).content.length > 20
        ? reply(413, { statusCode: 413, message: 'Draft too large' })
        : undefined;
    type('Once upon a tide, the keeper slept.');
    await elapse(60_000);
    expect(draftSaves()).toHaveLength(1);
    expect(status()).toBe('Not saved');
    expect(screen.getByRole('alert').textContent).toContain('Change it to save again');

    type('Once upon a tide.!');
    await elapse(1000);
    expect(status()).toBe('Draft saved · changed since revision 2');
    expect(server().draft?.content).toBe('Once upon a tide.!');
  });

  describe('when the draft was changed on another device', () => {
    const base = 'Le gardien dort. La mer monte.';
    const theirs = 'Le gardien veille. La mer monte.';
    const other = versionName('theirs', new Date());
    const local = versionName('mine', new Date());

    /** The document opens on `base`; another device saves `theirs`; this one types `mine`, and gets the conflict. */
    const conflict = async (mine: string) => {
      db.set('doc-1', fresh('doc-1', 'Le phare', base));
      queryClient.setQueryData(queryKeys.document('doc-1'), server());
      open();
      otherDraft(theirs);
      type(mine);
      await elapse(1000);
      expect(status()).toBe('Not saved · changed elsewhere');
      expect(screen.getByRole('alert').textContent).toContain('This text was also changed on another device.');
      calls = [];
    };

    const view = () =>
      screen.getByRole('heading', { name: 'Both versions changed' }).closest('.reconcile') as HTMLElement;
    const compare = () => fireEvent.click(screen.getByRole('button', { name: 'Compare and merge' }));
    const confirm = async () => {
      fireEvent.click(within(view()).getByRole('button', { name: 'Confirm' }));
      await elapse();
    };
    /** The merged text of a stopped confirmation is shown until the writer retries it or dismisses it. */
    const retry = async () => {
      fireEvent.click(within(view()).getByRole('button', { name: 'Retry with this text' }));
      await elapse();
    };
    const dismissPrevious = () => {
      const previous = view().querySelector('.reconcile-previous');
      if (previous !== null) fireEvent.click(within(previous as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    };
    const requests = () => calls.map(({ method, path }) => `${method} ${path.replace('/documents/doc-1', '')}`);
    const kept = () => revisions.map(({ name, content }) => [name, content]);

    it('opens the view in place of the text, on the base, the local text and the other device’s draft', async () => {
      await conflict('Le gardien dort. La mer descend.');
      compare();
      expect(screen.queryByPlaceholderText('Start writing…')).toBeNull();
      const text = view().querySelector('.reconcile-text')?.textContent;
      expect(text).toContain('Removed by Other device: dort');
      expect(text).toContain('Added by Other device: veille');
      expect(text).toContain('Removed by This device: monte');
      expect(text).toContain('Added by This device: descend');
      expect(within(view()).getByRole('status').textContent).toBe('Everything is resolved.');
      // Nothing is sent before the writer confirms.
      await elapse(5000);
      expect(calls).toEqual([]);
    });

    it('with no conflict, keeps both texts as versions, then saves the merged text on the confirmed counter', async () => {
      const mine = 'Le gardien dort. La mer descend.';
      await conflict(mine);
      compare();
      await confirm();

      expect(requests()).toEqual(['GET ', 'POST /revisions', 'PUT /draft', 'POST /revisions', 'PUT /draft']);
      expect(calls.at(-1)?.body).toEqual({ content: 'Le gardien veille. La mer descend.', draftVersion: 5 });
      expect(kept()).toEqual([
        [other, theirs],
        [local, mine],
      ]);
      expect(server().draft?.content).toBe('Le gardien veille. La mer descend.');
      expect(textarea().value).toBe('Le gardien veille. La mer descend.');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(status()).toBe('Draft saved · changed since revision 4');
      expect(unload().defaultPrevented).toBe(false);
    });

    it('keeping this device’s text keeps only the other text as a version', async () => {
      const mine = 'Le gardien rêve. La mer monte.';
      await conflict(mine);
      compare();
      fireEvent.click(within(view()).getByRole('button', { name: 'Keep This device' }));
      await confirm();

      expect(requests()).toEqual(['GET ', 'POST /revisions', 'PUT /draft']);
      expect(kept()).toEqual([[other, theirs]]);
      expect(server().draft?.content).toBe(mine);
      expect(status()).toBe('Draft saved · changed since revision 3');
    });

    it('keeping the other device’s text keeps both texts, the other device’s before the local text is written over it', async () => {
      const mine = 'Le gardien rêve. La mer monte.';
      await conflict(mine);
      compare();
      fireEvent.click(within(view()).getByRole('button', { name: 'Keep Other device' }));
      await confirm();

      expect(requests()).toEqual(['GET ', 'POST /revisions', 'PUT /draft', 'POST /revisions', 'PUT /draft']);
      expect(kept()).toEqual([
        [other, theirs],
        [local, mine],
      ]);
      expect(server().draft?.content).toBe(theirs);
      expect(textarea().value).toBe(theirs);
      expect(status()).toBe('Draft saved · changed since revision 4');
    });

    /** Every text on the server: the draft and the history. */
    const serverTexts = () => [server().draft?.content, ...revisions.map((revision) => revision.content)];
    const choices = [
      { choice: 'the other device’s text', resolve: () => fireEvent.click(keepOther()) },
      { choice: 'a hand edit', resolve: () => handEdit('rêve et veille') },
    ];
    const keepOther = () => within(view()).getByRole('button', { name: 'Keep Other device' });
    const handEdit = (text: string) => {
      fireEvent.click(within(view()).getByRole('button', { name: 'Edit by hand' }));
      fireEvent.change(within(view()).getByRole('textbox', { name: 'Your text for this passage' }), {
        target: { value: text },
      });
    };

    /**
     * Checks, after each write the server accepts, that the other device's text is still on the server, and, without
     * `afterWrite`, that the local text stays there once written: closing the tab at any point loses neither. (With
     * `afterWrite`, another device may write over the local text: it is still on screen, and kept on the next confirm.)
     */
    const watchWrites = (mine: string, afterWrite?: (count: number) => void) => {
      const violations: string[] = [];
      let writes = 0;
      let mineWritten = false;
      intercept = (call) => {
        if (call.method === 'GET') return undefined;
        const response = fakeApi(call);
        if (!response.ok) return response;
        writes++;
        const texts = serverTexts();
        if (!texts.includes(theirs)) violations.push(`write ${writes}: the other device's text is gone`);
        mineWritten ||= texts.includes(mine);
        if (mineWritten && !texts.includes(mine) && afterWrite === undefined)
          violations.push(`write ${writes}: the local text is gone`);
        afterWrite?.(writes);
        return response;
      };
      return violations;
    };

    it.each(choices)('keeps both texts on the server after every write, choosing $choice', async ({ resolve }) => {
      const mine = 'Le gardien rêve. La mer monte.';
      await conflict(mine);
      const violations = watchWrites(mine);
      compare();
      resolve();
      await confirm();

      expect(violations).toEqual([]);
      expect(kept().map(([, content]) => content)).toEqual([theirs, mine]);
    });

    const concurrent = choices.flatMap((choice) => [1, 2, 3].map((write) => ({ ...choice, write })));
    it.each(concurrent)(
      'loses nothing when the other device writes right after write $write, choosing $choice',
      async ({ resolve, write }) => {
        const mine = 'Le gardien rêve. La mer monte.';
        const later = 'Le gardien chante. La mer monte.';
        await conflict(mine);
        const violations = watchWrites(mine, (count) => count === write && otherDraft(later));
        compare();
        resolve();
        await confirm();

        // The sequence stopped, or the result met the new text on its way: either way, a conflict with it.
        expect(violations).toEqual([]);
        expect(status()).toBe('Not saved · changed elsewhere');
        expect(serverTexts()).toContain(theirs);
        if (screen.queryByRole('button', { name: 'Compare and merge' }) !== null) compare();
        expect(view().querySelector('.reconcile-text')?.textContent).toContain('Added by Other device: chante');
        dismissPrevious();

        for (const button of within(view()).getAllByRole('button', { name: 'Keep Other device' })) {
          fireEvent.click(button);
        }
        await confirm();
        expect(status()).toBe('Draft saved · changed since revision ' + server().revision);
        expect(server().draft?.content).toBe(later);
        expect(serverTexts()).toEqual(expect.arrayContaining([theirs, mine, later]));
        expect(violations).toEqual([]);
      },
    );

    describe('while a confirmation runs', () => {
      const mine = 'Le gardien rêve. La mer monte.';

      const start = async () => {
        await conflict(mine);
        compare();
        handEdit('rêve et veille');
        hold = (call) => call.method === 'POST';
        await confirm();
      };

      it('freezes the view, Cancel, and restoring a revision', async () => {
        const summary = { documentId: 'doc-1', revision: 1, title: 'Le phare', name: null, createdAt: '2026-11-01' };
        intercept = (call) => {
          if (call.method !== 'GET') return undefined;
          if (call.path === '/documents/doc-1/revisions') return reply(200, [summary]);
          if (call.path === '/documents/doc-1/revisions/1') return reply(200, { ...summary, content: 'Avant.' });
          return undefined;
        };
        await start();

        expect(screen.getByText('Saving the merged text…')).toBeTruthy();
        const disabled = (name: string) => within(view()).getByRole('button', { name }).hasAttribute('disabled');
        expect(
          ['Cancel', 'Saving…', 'Keep This device', 'Keep Other device', 'Keep both', 'Edit by hand'].map(disabled),
        ).toEqual([true, true, true, true, true, true]);
        expect(within(view()).getByRole('textbox', { name: 'Your text for this passage' })).toHaveProperty(
          'readOnly',
          true,
        );
        fireEvent.click(screen.getByRole('button', { name: 'History' }));
        await elapse();
        fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }));
        await elapse();
        expect(screen.getByRole('button', { name: 'Restore into editor' })).toHaveProperty('disabled', true);

        await releaseHeld();
        expect(server().draft?.content).toBe('Le gardien rêve et veille. La mer monte.');
        expect(textarea().value).toBe('Le gardien rêve et veille. La mer monte.');
      });

      it('runs only once, and does not apply its result over a text changed meanwhile', async () => {
        await start();
        // The writer leaves and comes back: the text is read-only until the confirmation ends.
        open('doc-2');
        await elapse();
        open('doc-1');
        await elapse();
        expect(textarea()).toHaveProperty('readOnly', true);
        expect(screen.getByText('Saving the merged text…')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Compare and merge' })).toBeNull();

        // Should the text change anyway, the result is not applied over it, and stays recoverable.
        type('Le gardien rêve encore.');
        await releaseHeld();
        await elapse(5000);
        expect(textarea().value).toBe('Le gardien rêve encore.');
        expect(status()).toBe('Not saved · changed elsewhere');
        expect(server().draft?.content).toBe(mine);
        expect(kept().map(([, content]) => content)).toEqual([theirs, mine]);
        expect(requests().filter((request) => request === 'POST /revisions')).toHaveLength(2);
        expect(screen.getByRole('alert').textContent).toContain('Your text changed while the merge was being saved');
        compare();
        expect(within(view()).getByRole('textbox', { name: 'Your merged text' })).toHaveProperty(
          'value',
          'Le gardien rêve et veille. La mer monte.',
        );
      });

      it.each([
        {
          stop: 'fails',
          banner: 'The merge could not be finished',
          act: () => {
            intercept = (call) => (call.method === 'POST' ? reply(503) : undefined);
          },
        },
        {
          stop: 'meets a new text',
          banner: 'The other device changed the text again',
          act: () => otherDraft('Le gardien chante. La mer monte.'),
        },
      ])('keeps a confirmed hand edit when the confirmation $stop after the writer left', async ({ banner, act }) => {
        const merged = 'Le gardien rêve et veille. La mer monte.';
        await start();
        open('doc-2');
        await elapse();
        open('doc-1');
        await elapse();
        act();
        await releaseHeld();
        intercept = () => undefined;

        // The editor shown now did not start the confirmation: it still says what happened, and the text is kept.
        expect(screen.getByRole('alert').textContent).toContain(banner);
        expect(screen.getByRole('alert').textContent).toContain('It is kept');
        expect(serverTexts()).toContain(theirs);
        compare();
        expect(within(view()).getByRole('textbox', { name: 'Your merged text' })).toHaveProperty('value', merged);
        expect(within(view()).getByRole('button', { name: 'Confirm' })).toHaveProperty('disabled', true);

        await retry();
        expect(server().draft?.content).toBe(merged);
        expect(textarea().value).toBe(merged);
        expect(serverTexts()).toEqual(expect.arrayContaining([theirs, mine]));
        expect(status()).toBe('Draft saved · changed since revision ' + server().revision);
      });
    });

    it('keeps the other device’s text when that device wrote exactly the local text before the confirmation', async () => {
      const mine = 'Le gardien rêve. La mer monte.';
      await conflict(mine);
      compare();
      handEdit('rêve et veille');
      otherDraft(mine);
      await confirm();

      expect(kept()).toEqual([
        [local, mine],
        [other, theirs],
      ]);
      expect(server().draft?.content).toBe('Le gardien rêve et veille. La mer monte.');
      expect(status()).toBe('Draft saved · changed since revision 4');
    });

    it('a hand edit keeps both texts, the other device’s first', async () => {
      const mine = 'Le gardien rêve. La mer monte.';
      await conflict(mine);
      compare();
      fireEvent.click(within(view()).getByRole('button', { name: 'Edit by hand' }));
      fireEvent.change(within(view()).getByRole('textbox', { name: 'Your text for this passage' }), {
        target: { value: 'rêve et veille' },
      });
      await confirm();

      expect(kept()).toEqual([
        [other, theirs],
        [local, mine],
      ]);
      expect(server().draft?.content).toBe('Le gardien rêve et veille. La mer monte.');
    });

    it('cancelling goes back to the text, still in conflict, and the page still warns', async () => {
      const mine = 'Le gardien rêve. La mer monte.';
      await conflict(mine);
      compare();
      expect(unload().defaultPrevented).toBe(true);
      fireEvent.click(within(view()).getByRole('button', { name: 'Cancel' }));

      expect(textarea().value).toBe(mine);
      expect(screen.getByRole('button', { name: 'Compare and merge' })).toBeTruthy();
      expect(status()).toBe('Not saved · changed elsewhere');
      expect(unload().defaultPrevented).toBe(true);
      await elapse(5000);
      expect(calls).toEqual([]);
      expect(server().draft?.content).toBe(theirs);
    });

    it('after a failure mid-sequence, keeps the conflict and the text, and a retry keeps nothing twice', async () => {
      const mine = 'Le gardien dort. La mer descend.';
      await conflict(mine);
      compare();
      // The local text is saved as the draft, then making it a version fails.
      intercept = (call) => (call.method === 'POST' && server().draft?.content === mine ? reply(503) : undefined);
      await confirm();

      expect(requests()).toEqual(['GET ', 'POST /revisions', 'PUT /draft', 'POST /revisions']);
      expect(screen.getByRole('alert').textContent).toContain('The merge could not be finished');
      expect(status()).toBe('Not saved · changed elsewhere');
      expect(unload().defaultPrevented).toBe(true);
      // The view still shows the other device's text, not this device's own write.
      expect(view().querySelector('.reconcile-text')?.textContent).toContain('Added by Other device: veille');

      intercept = () => undefined;
      calls = [];
      await retry();
      expect(requests()).toEqual(['GET ', 'POST /revisions', 'PUT /draft']);
      expect(kept()).toEqual([
        [other, theirs],
        [local, mine],
      ]);
      expect(server().draft?.content).toBe('Le gardien veille. La mer descend.');
      expect(status()).toBe('Draft saved · changed since revision 4');
    });

    it('a retry after a lost answer keeps nothing twice', async () => {
      const mine = 'Le gardien dort. La mer descend.';
      await conflict(mine);
      compare();
      // The other device's text becomes a version, but the answer is lost.
      intercept = (call) => {
        if (call.method !== 'POST') return undefined;
        intercept = () => undefined;
        fakeApi(call);
        return reply(503);
      };
      await confirm();
      expect(kept()).toEqual([[other, theirs]]);
      expect(screen.getByRole('alert').textContent).toContain('The merge could not be finished');

      calls = [];
      await retry();
      expect(requests()).toEqual(['GET ', 'PUT /draft', 'POST /revisions', 'PUT /draft']);
      expect(kept()).toEqual([
        [other, theirs],
        [local, mine],
      ]);
      expect(server().draft?.content).toBe('Le gardien veille. La mer descend.');
    });

    it('when the other device writes again mid-sequence, the view takes its new text and nothing is saved', async () => {
      const mine = 'Le gardien dort. La mer descend.';
      await conflict(mine);
      compare();
      intercept = (call) => {
        if (call.method !== 'PUT') return undefined;
        intercept = () => undefined;
        otherDraft('Le gardien chante. La mer monte.');
        return undefined;
      };
      await confirm();

      // The new text is kept before the local text is written over it, then given back as the draft.
      expect(requests()).toEqual([
        'GET ',
        'POST /revisions',
        'PUT /draft',
        'GET ',
        'POST /revisions',
        'PUT /draft',
        'POST /revisions',
        'PUT /draft',
      ]);
      expect(screen.getByRole('alert').textContent).toContain('The other device changed the text again');
      expect(view().querySelector('.reconcile-text')?.textContent).toContain('Added by Other device: chante');
      expect(status()).toBe('Not saved · changed elsewhere');
      expect(server().draft?.content).toBe('Le gardien chante. La mer monte.');

      calls = [];
      dismissPrevious();
      await confirm();
      expect(kept()).toEqual([
        [other, theirs],
        [other, 'Le gardien chante. La mer monte.'],
        [local, mine],
      ]);
      expect(server().draft?.content).toBe('Le gardien chante. La mer descend.');
      expect(status()).toBe('Draft saved · changed since revision 5');
    });
  });

  describe('"Save version"', () => {
    it('saves the draft first, then creates the version, and later edits save on the same counter', async () => {
      open();
      type('The end.');
      fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await elapse();

      expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
        'PUT /documents/doc-1/draft',
        'PUT /documents/doc-1',
      ]);
      expect(revisions.map((revision) => revision.content)).toEqual(['The end.']);
      expect(status()).toBe('Saved · revision 3');

      // The version did not move the draft's counter: the next edit saves without a conflict.
      type('The end. Or is it?');
      await elapse(1000);
      expect(status()).toBe('Draft saved · changed since revision 3');
      expect(server().draft?.content).toBe('The end. Or is it?');
    });

    it('after a newer version elsewhere, "Keep my version" moves the counter, and the next edit still saves', async () => {
      open();
      type('Mine.');
      await elapse(1000);
      // Another device saves a version over it.
      appendRevision(server(), 'The lighthouse keeper', 'Theirs.');
      fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
      await elapse();
      expect(screen.getByText('A newer version was saved elsewhere since you opened this document.')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Keep my version' }));
      await elapse();
      expect(revisions.map((revision) => revision.content)).toEqual(['Theirs.', 'Mine.']);
      expect(server().draft?.draftVersion).toBe(6);

      type('Mine, again.');
      await elapse(1000);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(status()).toBe('Draft saved · changed since revision 4');
      expect(server().draft?.content).toBe('Mine, again.');
    });

    it('Ctrl+S creates no version when the draft cannot be saved', async () => {
      open();
      intercept = (call) => (call.path.endsWith('/draft') ? reply(503) : undefined);
      type('The end.');
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      await elapse();

      expect(calls.map((call) => call.path)).toEqual(['/documents/doc-1/draft']);
      expect(status()).toBe('Not saved · retrying');
    });
  });

  it('restores a revision into the editor as an edit of the draft', async () => {
    const summary = { documentId: 'doc-1', revision: 1, title: 'Keeper', name: null, createdAt: '2026-11-01' };
    intercept = (call) => {
      if (call.path === '/documents/doc-1/revisions') return reply(200, [summary]);
      if (call.path === '/documents/doc-1/revisions/1') return reply(200, { ...summary, content: 'A dark tide.' });
      return undefined;
    };
    open();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await elapse();
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }));
    await elapse();
    fireEvent.click(screen.getByRole('button', { name: 'Restore into editor' }));

    expect(textarea().value).toBe('A dark tide.');
    await elapse(1000);
    expect(server().draft?.content).toBe('A dark tide.');
    expect(revisions).toEqual([]);
  });

  describe('reopening a document', () => {
    it('shows the saved draft once its machine is gone', async () => {
      open();
      type('Once upon a tide, the keeper slept.');
      open('doc-2');
      await elapse();
      expect(server().draft?.content).toBe('Once upon a tide, the keeper slept.');

      open('doc-1');
      await elapse();
      expect(textarea().value).toBe('Once upon a tide, the keeper slept.');
      expect(status()).toBe('Draft saved · changed since revision 2');
    });

    it('shows the text of a machine still saving in the background', async () => {
      open();
      hold = (call) => call.path === '/documents/doc-1/draft';
      type('Once upon a tide, the keeper slept.');
      open('doc-2');
      await elapse();
      open('doc-1');
      await elapse();
      expect(textarea().value).toBe('Once upon a tide, the keeper slept.');
      expect(status()).toBe('Saving…');

      await releaseHeld();
      expect(status()).toBe('Draft saved · changed since revision 2');
    });

    it('takes a newer draft from the server when nothing local is pending', async () => {
      otherDraft('Written on the phone.');
      queryClient.setQueryDefaults(queryKeys.document('doc-1'), { staleTime: 0 });
      open();
      expect(textarea().value).toBe('Once upon a tide.');
      await elapse();
      expect(textarea().value).toBe('Written on the phone.');
      expect(status()).toBe('Draft saved · changed since revision 2');
    });

    it('keeps local edits over a newer draft from the server, and shows the conflict', async () => {
      open();
      type('Written here.');
      otherDraft('Written on the phone.');
      await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.document('doc-1') }));
      await elapse();
      expect(textarea().value).toBe('Written here.');

      await elapse(1000);
      expect(textarea().value).toBe('Written here.');
      expect(status()).toBe('Not saved · changed elsewhere');
    });
  });

  it('shows a conflict, not "saved", when a draft read during a slow save is newer than its answer', async () => {
    open();
    delay = (call) => call.path === '/documents/doc-1/draft';
    type('Written here.');
    await elapse(1000);
    expect(server().draft).toMatchObject({ content: 'Written here.', draftVersion: 4 });
    // The answer is still on its way; another device writes, and a refetch reads it.
    otherDraft('Written on the phone.');
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.document('doc-1') }));
    await elapse();
    expect(status()).toBe('Saving…');

    await releaseHeld();
    expect(textarea().value).toBe('Written here.');
    expect(status()).toBe('Not saved · changed elsewhere');
    expect(queryClient.getQueryData<Document>(queryKeys.document('doc-1'))?.draft).toMatchObject({
      content: 'Written on the phone.',
      draftVersion: 5,
    });
    expect(unload().defaultPrevented).toBe(true);
  });

  it('shows a conflict, not "saved", when the writer goes back to the draft while a refused save was pending', async () => {
    open();
    intercept = (call) =>
      call.path.endsWith('/draft') && (call.body as SaveDraftInput).content.length > 20
        ? reply(413, { statusCode: 413, message: 'Draft too large' })
        : undefined;
    hold = (call) => call.path === '/documents/doc-1/draft';
    type('Once upon a tide, the keeper slept.');
    await elapse(1000);
    // Another device writes, a refetch reads it, and the writer goes back to the text they opened.
    otherDraft('Written on the phone.');
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.document('doc-1') }));
    type('Once upon a tide.');
    await elapse();

    await releaseHeld();
    expect(textarea().value).toBe('Once upon a tide.');
    expect(status()).toBe('Not saved · changed elsewhere');
    expect(unload().defaultPrevented).toBe(true);
    expect(server().draft?.content).toBe('Written on the phone.');
  });

  describe('leaving inside the debounce window still saves', () => {
    it('when the tab is hidden', async () => {
      open();
      type('Once upon a tide, the keeper slept.');
      const visibility = vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('hidden');
      fireEvent(window.document, new Event('visibilitychange'));
      await elapse();
      visibility.mockRestore();
      expect(draftSaves()).toHaveLength(1);
      expect(status()).toBe('Draft saved · changed since revision 2');
    });

    it('when the page is closed, and warns until the text is saved', async () => {
      open();
      type('Once upon a tide, the keeper slept.');
      expect(unload().defaultPrevented).toBe(true);
      expect(draftSaves()).toHaveLength(1);
      await elapse();
      expect(unload().defaultPrevented).toBe(false);
    });

    it('saves a document left earlier on "pagehide", with no editor open', async () => {
      open();
      intercept = (call) => (call.path.endsWith('/draft') ? reply(503) : undefined);
      type('Once upon a tide, the keeper slept.');
      // An id that opens no editor: only the app's guard is left.
      open('');
      await elapse();
      expect(screen.queryByPlaceholderText('Start writing…')).toBeNull();
      expect(draftSaves()).toHaveLength(1);
      // Closing warns, and its own flush fails too.
      expect(unload().defaultPrevented).toBe(true);
      await elapse();
      expect(draftSaves()).toHaveLength(2);

      intercept = () => undefined;
      window.dispatchEvent(new Event('pagehide'));
      await elapse();
      expect(server().draft?.content).toBe('Once upon a tide, the keeper slept.');
      expect(unload().defaultPrevented).toBe(false);
    });

    it("removes the guard's listeners when the app goes away", () => {
      const added = [vi.spyOn(window, 'addEventListener'), vi.spyOn(window.document, 'addEventListener')];
      const removed = [vi.spyOn(window, 'removeEventListener'), vi.spyOn(window.document, 'removeEventListener')];
      open();
      cleanup();
      const listeners = (spies: typeof added) =>
        spies
          .flatMap((spy) => spy.mock.calls)
          .filter(([type]) => ['pagehide', 'beforeunload', 'visibilitychange'].includes(type))
          .map(([type, listener]) => [type, listener]);
      expect(new Set(listeners(added).map(([type]) => type))).toEqual(
        new Set(['pagehide', 'beforeunload', 'visibilitychange']),
      );
      expect(listeners(removed)).toEqual(expect.arrayContaining(listeners(added)));
      for (const spy of [...added, ...removed]) spy.mockRestore();
    });

    it('warns on closing the page while a document left earlier is still unsaved', async () => {
      open();
      hold = (call) => call.path === '/documents/doc-1/draft';
      type('Once upon a tide, the keeper slept.');
      open('doc-2');
      await elapse();
      expect(textarea().value).toBe('Dear sea,');
      expect(status()).toBe('Saved · revision 2');

      expect(unload().defaultPrevented).toBe(true);
      await releaseHeld();
      expect(server().draft?.content).toBe('Once upon a tide, the keeper slept.');
      expect(unload().defaultPrevented).toBe(false);
    });
  });
});
