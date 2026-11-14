import type {
  CreateDocumentInput,
  CreateRevisionInput,
  Document,
  SaveDraftInput,
  UpdateDocumentInput,
} from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { entryOf, useAutosaveGuard } from '../autosave/useAutosave';
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

const notFound = () => reply(404, { statusCode: 404, message: 'Not found' });

const base = 'Le gardien dort. La mer monte.';
/** The other device's text, and this device's: they merge without a conflict into `merged`. */
const theirs = 'Le gardien veille. La mer monte.';
const mine = 'Le gardien dort. La mer descend.';
const merged = 'Le gardien veille. La mer descend.';

const fresh = (id: string, title: string | null, content: string): Document => ({
  id,
  title,
  revision: 2,
  content,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  draft: { content, draftVersion: 3, baseRevision: 2 },
});

/** The server's documents, and the texts of their revisions. */
let db: Map<string, Document>;
let revisions: { documentId: string; name: string | null; content: string }[];
let created: number;

/** The API's rules for reading a document, saving its draft, creating a version, and creating a document. */
const fakeApi = ({ method, path, body }: Call): Response => {
  if (method === 'POST' && path === '/documents') {
    const input = body as CreateDocumentInput;
    const document = { ...fresh(`new-${++created}`, input.title ?? null, input.content), revision: 1 };
    db.set(document.id, document);
    return reply(201, document);
  }
  const [, , id, sub] = path.split('/');
  const document = id === undefined ? undefined : db.get(id);
  if (document?.draft === undefined) return notFound();
  const { draft } = document;
  if (method === 'GET' && sub === undefined) return reply(200, document);
  if (method === 'DELETE' && sub === undefined) {
    db.delete(document.id);
    return reply(204);
  }
  if (method === 'PUT' && sub === undefined) {
    // "Save version" through the old endpoint: the text becomes a revision, and the draft.
    const input = body as UpdateDocumentInput;
    if (document.revision !== input.baseRevision) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'stale_revision', revision: document.revision });
    }
    const revision = document.revision + 1;
    const next: Document = {
      ...document,
      title: input.title ?? null,
      content: input.content,
      revision,
      draft: {
        content: input.content,
        draftVersion: draft.content === input.content ? draft.draftVersion : draft.draftVersion + 1,
        baseRevision: revision,
      },
    };
    db.set(document.id, next);
    revisions.push({ documentId: document.id, name: null, content: input.content });
    return reply(200, next);
  }
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
    if (draft.content === document.content) return reply(200, document);
    const next: Document = {
      ...document,
      revision: document.revision + 1,
      content: draft.content,
      draft: { ...draft, baseRevision: document.revision + 1 },
    };
    db.set(document.id, next);
    revisions.push({ documentId: document.id, name: input.name ?? null, content: draft.content });
    return reply(200, next);
  }
  return notFound();
};

const server = (id = 'doc-1') => {
  const document = db.get(id);
  if (document?.draft === undefined) throw new Error(`No ${id} on the server`);
  return document;
};

/** Another device saves a draft. */
const otherDraft = (content: string) => {
  const document = server();
  const draft = document.draft ?? { content: document.content, draftVersion: 1, baseRevision: null };
  db.set(document.id, { ...document, draft: { ...draft, content, draftVersion: draft.draftVersion + 1 } });
};

let calls: Call[];
/** Answers a request instead of the fake API, when it returns a response. */
let intercept: (call: Call) => Response | undefined;
/** Requests matching `delay` are handled by the API at once, but their answer arrives only at `releaseHeld`. */
let delay: (call: Call) => boolean;
let held: (() => void)[];
let queryClient: QueryClient;
let rerender: ((id: string) => void) | undefined;

/** The app around the document view: opening a document created from a recovered text switches to it. */
const Harness = ({ id }: { id: string }) => {
  useAutosaveGuard();
  return <DocumentView key={id} id={id} onDeleted={() => {}} onGoBack={() => {}} onOpen={(next) => show(next.id)} />;
};

const show = (id: string) => {
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

const open = async (id = 'doc-1') => {
  show(id);
  await elapse();
};

/** The document is read again, as on window focus. */
const refetch = async (id = 'doc-1') => {
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: queryKeys.document(id) });
  });
  await elapse();
};

/** The writer leaves the document, and comes back once the app forgot it, so it is read again. */
const leaveAndComeBack = async () => {
  await open('doc-2');
  await elapse(1000);
  queryClient.removeQueries({ queryKey: queryKeys.document('doc-1') });
  await open('doc-1');
};

const textarea = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…');
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
const unload = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

/** The texts a section lists: each label with its read-only text. */
const listed = (root: HTMLElement = document.body) =>
  [...root.querySelectorAll<HTMLElement>('.held-text')].map((section) => [
    section.querySelector('h3')?.textContent,
    section.querySelector('textarea')?.value,
  ]);
const recovery = () => screen.queryByRole('heading', { name: 'This document was deleted elsewhere' });
const isNotFoundPage = () => screen.queryByText('Oh, no tale told here.') !== null;

const view = () => screen.getByRole('heading', { name: 'Both versions changed' }).closest('.reconcile') as HTMLElement;
const compare = () => fireEvent.click(screen.getByRole('button', { name: 'Compare and merge' }));
const confirm = async () => {
  fireEvent.click(within(view()).getByRole('button', { name: 'Confirm' }));
  await elapse();
};
const dismissPrevious = () =>
  fireEvent.click(
    within(view().querySelector<HTMLElement>('.reconcile-previous') as HTMLElement).getByRole('button', {
      name: 'Dismiss',
    }),
  );
const heldTexts = () => document.querySelector<HTMLElement>('.held-texts');

/** The document opens on `base`; another device saves `theirs`; this one types `local`, and gets the conflict. */
const conflict = async (local = mine) => {
  db.set('doc-1', fresh('doc-1', 'Le phare', base));
  queryClient.setQueryData(queryKeys.document('doc-1'), server());
  await open();
  otherDraft(theirs);
  type(local);
  await elapse(1000);
  expect(screen.getByRole('alert').textContent).toContain('This text was also changed on another device.');
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  db = new Map(
    [fresh('doc-1', 'Le phare', 'Il était une fois.'), fresh('doc-2', 'Lettres', 'Chère mer,')].map((document) => [
      document.id,
      document,
    ]),
  );
  revisions = [];
  created = 0;
  calls = [];
  intercept = () => undefined;
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
    if (call.method === 'GET' && call.path.includes('/revisions')) return Promise.resolve(reply(200, []));
    calls.push(call);
    const response = intercept(call) ?? fakeApi(call);
    if (delay(call)) return new Promise<Response>((resolve) => held.push(() => resolve(response)));
    return Promise.resolve(response);
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

describe('a document deleted elsewhere', () => {
  const typed = 'Il était une fois un phare, et son gardien qui ne dormait jamais.';

  it('keeps the unsaved text on screen when the document is read again in an open editor', async () => {
    await open();
    db.delete('doc-1');
    type(typed);
    await elapse(1000);
    expect(screen.getByRole('alert').textContent).toContain('This document was deleted elsewhere');

    await refetch();
    expect(recovery()).not.toBeNull();
    expect(listed()).toEqual([['Your text', typed]]);
    expect(unload().defaultPrevented).toBe(true);
  });

  it('keeps a text typed just before the read, not sent yet', async () => {
    await open();
    db.delete('doc-1');
    type(typed);
    await refetch();
    expect(listed()).toEqual([['Your text', typed]]);
    // Leaving the editor sent it: the server refused it, and it stays.
    await elapse(5000);
    expect(listed()).toEqual([['Your text', typed]]);
  });

  it('keeps the unsaved text after leaving the document and coming back', async () => {
    await open();
    db.delete('doc-1');
    type(typed);
    await leaveAndComeBack();
    expect(recovery()).not.toBeNull();
    expect(listed()).toEqual([['Your text', typed]]);
  });

  it('keeps a text this tab edited and saved, after leaving and coming back, until it is discarded', async () => {
    await open();
    type(typed);
    await elapse(1000);
    expect(server().draft?.content).toBe(typed);
    db.delete('doc-1');
    await refetch();
    expect(listed()).toEqual([['Your text', typed]]);
    expect(unload().defaultPrevented).toBe(true);

    await leaveAndComeBack();
    expect(listed()).toEqual([['Your text', typed]]);
    expect(unload().defaultPrevented).toBe(true);
  });

  it('keeps the texts reachable while later reads of the deleted document fail for another reason', async () => {
    await open();
    type(typed);
    await elapse(1000);
    db.delete('doc-1');
    await refetch();
    expect(listed()).toEqual([['Your text', typed]]);

    // The server becomes unreachable. A failed read says nothing about the document: the deletion stays known, and
    // the page must not turn into "could not load" with the text out of reach.
    intercept = (call) =>
      call.method === 'GET' && call.path === '/documents/doc-1'
        ? reply(503, { statusCode: 503, message: 'Service Unavailable' })
        : undefined;
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: queryKeys.document('doc-1') });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(recovery()).not.toBeNull();
    expect(listed()).toEqual([['Your text', typed]]);
    expect(screen.getByRole('button', { name: 'Save as a new document' })).not.toBeNull();

    // The same once the app forgot the query: while the read is pending, and once it has failed.
    await leaveAndComeBack();
    expect(recovery()).not.toBeNull();
    expect(listed()).toEqual([['Your text', typed]]);
    await elapse(10_000);
    expect(recovery()).not.toBeNull();
    expect(listed()).toEqual([['Your text', typed]]);
    expect(unload().defaultPrevented).toBe(true);
  });

  it('keeps a text whose save succeeded, when the answer arrives after the deletion was read', async () => {
    await open();
    delay = (call) => call.method === 'PUT';
    type(typed);
    await elapse(1000);
    // The server took the text; its answer is late.
    expect(server().draft?.content).toBe(typed);
    db.delete('doc-1');
    await refetch();
    expect(listed()).toEqual([['Your text', typed]]);

    delay = () => false;
    for (const answer of held.splice(0)) answer();
    await elapse();
    expect(listed()).toEqual([['Your text', typed]]);
    expect(unload().defaultPrevented).toBe(true);
    await leaveAndComeBack();
    expect(listed()).toEqual([['Your text', typed]]);
  });

  describe('answers that arrive out of order', () => {
    const later = `${typed} Il dormait enfin.`;
    const readsDocument = (call: Call) => call.method === 'GET' && call.path === '/documents/doc-1';
    const savesDraft = (call: Call) => call.method === 'PUT' && call.path === '/documents/doc-1/draft';
    const savesVersion = (call: Call) => call.method === 'PUT' && call.path === '/documents/doc-1';
    /** A read the app starts on its own (window focus, a remount), without waiting for it. */
    const startRead = async () => {
      act(() => void queryClient.refetchQueries({ queryKey: queryKeys.document('doc-1') }));
      await elapse();
    };
    const answer = async (index: number) => {
      held[index]?.();
      await elapse();
    };
    const answerAll = async () => {
      for (const release of held.splice(0)) release();
      await elapse();
    };

    /** Requests the server answers with a success that arrives late: the text was typed and saved before. */
    const lateSuccesses = [
      {
        request: 'a draft save',
        start: async () => {
          delay = savesDraft;
          type(typed);
          await elapse(1000);
        },
      },
      {
        request: 'a version save',
        start: async () => {
          type(typed);
          await elapse(1000);
          delay = savesVersion;
          fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
          await elapse();
        },
      },
      {
        request: 'a read',
        start: async () => {
          type(typed);
          await elapse(1000);
          delay = readsDocument;
          await startRead();
        },
      },
    ];

    /** The text stays offered: the page warns on closing, and the machine survives leaving. */
    const stillRecovered = async () => {
      expect(listed()).toEqual([['Your text', typed]]);
      expect(unload().defaultPrevented).toBe(true);
      await leaveAndComeBack();
      expect(listed()).toEqual([['Your text', typed]]);
      expect(entryOf(queryClient, 'doc-1')).toBeDefined();
      expect(unload().defaultPrevented).toBe(true);
    };

    it('keeps the deletion when a superseded read and a draft save answer after a newer 404', async () => {
      await open();
      delay = (call) => savesDraft(call) || readsDocument(call);
      type(typed);
      await elapse(1000);
      await startRead();
      expect(held).toHaveLength(2);
      db.delete('doc-1');
      delay = () => false;
      // A newer read cancels the held one, and answers 404.
      await refetch();
      expect(listed()).toEqual([['Your text', typed]]);

      await answer(1);
      expect(listed()).toEqual([['Your text', typed]]);
      await answer(0);
      held = [];
      await stillRecovered();
    });

    it.each(lateSuccesses)('keeps the deletion when $request answers after a newer 404', async ({ start }) => {
      await open();
      await start();
      expect(held).toHaveLength(1);
      db.delete('doc-1');
      delay = () => false;
      await refetch();
      expect(listed()).toEqual([['Your text', typed]]);

      await answerAll();
      await stillRecovered();
    });

    it.each(lateSuccesses.slice(0, 2))(
      'after a wrong 404, $request answering does not undo it, and the next read does',
      async ({ start }) => {
        await open();
        await start();
        delay = () => false;
        intercept = (call) => (readsDocument(call) ? notFound() : undefined);
        await refetch();
        intercept = () => undefined;
        expect(listed()).toEqual([['Your text', typed]]);

        // A write's answer cannot tell whether the server took it before a deletion: only a read says it exists.
        await answerAll();
        expect(listed()).toEqual([['Your text', typed]]);
        expect(unload().defaultPrevented).toBe(true);

        await refetch();
        expect(recovery()).toBeNull();
        expect(textarea().value).toBe(typed);
        type(later);
        await elapse(1000);
        expect(server().draft?.content).toBe(later);
        expect(queryClient.getQueryData<Document>(queryKeys.document('doc-1'))?.draft?.content).toBe(later);
        expect(unload().defaultPrevented).toBe(false);
        await open('doc-2');
        await elapse(1000);
        expect(entryOf(queryClient, 'doc-1')).toBeUndefined();
        expect(unload().defaultPrevented).toBe(false);
      },
    );
  });

  it('works as usual again once a read finds the document after a wrong 404', async () => {
    const later = `${typed} Il dormait enfin.`;
    await open();
    type(typed);
    await elapse(1000);
    intercept = (call) => (call.method === 'GET' && call.path === '/documents/doc-1' ? notFound() : undefined);
    await refetch();
    expect(listed()).toEqual([['Your text', typed]]);

    intercept = () => undefined;
    await refetch();
    expect(recovery()).toBeNull();
    expect(textarea().value).toBe(typed);
    type(later);
    await elapse(1000);
    expect(server().draft?.content).toBe(later);
    expect(queryClient.getQueryData<Document>(queryKeys.document('doc-1'))?.draft?.content).toBe(later);
    expect(unload().defaultPrevented).toBe(false);

    await open('doc-2');
    await elapse(1000);
    expect(entryOf(queryClient, 'doc-1')).toBeUndefined();
    expect(unload().defaultPrevented).toBe(false);
  });

  it('shows "not found" for a text saved and left before the document was deleted elsewhere', async () => {
    // Once its text was saved and its editor left, the tab released the document: it no longer holds that text, so
    // there is nothing to offer. Guarding against a deletion made elsewhere, from a stale view, is a decision for the
    // server side (see docs/PLAN.md).
    await open();
    type(typed);
    await elapse(1000);
    await open('doc-2');
    await elapse(1000);
    expect(entryOf(queryClient, 'doc-1')).toBeUndefined();
    db.delete('doc-1');
    queryClient.removeQueries({ queryKey: queryKeys.document('doc-1') });
    await open('doc-1');
    expect(isNotFoundPage()).toBe(true);
    expect(unload().defaultPrevented).toBe(false);
  });

  it('shows "not found" for a document deleted from this tab, with no warning', async () => {
    await open();
    type(typed);
    await elapse(1000);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await elapse();
    expect(db.has('doc-1')).toBe(false);

    await leaveAndComeBack();
    expect(isNotFoundPage()).toBe(true);
    expect(recovery()).toBeNull();
    expect(unload().defaultPrevented).toBe(false);
  });

  it('shows "not found" when this tab never held text for it', async () => {
    await open();
    db.delete('doc-1');
    await refetch();
    expect(isNotFoundPage()).toBe(true);
    expect(recovery()).toBeNull();
    expect(unload().defaultPrevented).toBe(false);
  });

  it('shows "not found" for a document never opened in this tab', async () => {
    await open('doc-404');
    expect(isNotFoundPage()).toBe(true);
  });

  describe('during an unfinished merge', () => {
    const edited = 'Le gardien dort. La mer descend vers le large.';

    /**
     * The document is deleted before the merged text is confirmed: the merge stops. The writer goes back to the text
     * and edits it, then the document is read again.
     */
    const deletedDuringMerge = async () => {
      await conflict();
      compare();
      db.delete('doc-1');
      await confirm();
      expect(screen.getByRole('alert').textContent).toContain('The merge could not be finished');
      fireEvent.click(within(view()).getByRole('button', { name: 'Cancel' }));
      type(edited);
      await refetch();
      expect(recovery()).not.toBeNull();
    };

    const all = [
      ['Your text', edited],
      ['Your merged text, not applied', merged],
      ['The other device’s text', theirs],
      ['An earlier text of yours', mine],
    ];

    it('lists every text it holds, each labelled', async () => {
      await deletedDuringMerge();
      expect(listed()).toEqual(all);
      await leaveAndComeBack();
      expect(listed()).toEqual(all);
    });

    it.each(all)(
      'saves "%s" as a new document holding exactly that text, and discards nothing',
      async (label, text) => {
        await deletedDuringMerge();
        const section = screen.getByRole('region', { name: label });
        fireEvent.click(within(section).getByRole('button', { name: 'Save as a new document' }));
        await elapse();

        expect(
          calls.filter((call) => call.method === 'POST' && call.path === '/documents').map((call) => call.body),
        ).toEqual([{ title: 'Le phare', content: text }]);
        expect(server('new-1').draft?.content).toBe(text);
        // The new document is open.
        expect(textarea().value).toBe(text);

        await open('doc-1');
        expect(listed()).toEqual(all);
      },
    );

    it('discards every text only through the action that says so', async () => {
      await deletedDuringMerge();
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
      fireEvent.click(screen.getByRole('button', { name: 'Discard these copies' }));
      expect(ask).toHaveBeenCalledWith('Discard the copies this tab holds? This tab will no longer show them.');
      expect(listed()).toEqual(all);

      ask.mockReturnValue(true);
      fireEvent.click(screen.getByRole('button', { name: 'Discard these copies' }));
      await elapse();
      expect(isNotFoundPage()).toBe(true);
      expect(unload().defaultPrevented).toBe(false);
      await leaveAndComeBack();
      expect(isNotFoundPage()).toBe(true);
    });

    it('copies a text', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      await deletedDuringMerge();
      const section = screen.getByRole('region', { name: 'Your merged text, not applied' });
      fireEvent.click(within(section).getByRole('button', { name: 'Copy' }));
      await elapse();
      expect(writeText).toHaveBeenCalledWith(merged);
      expect(within(section).getByRole('button', { name: 'Copied' })).toBeTruthy();
      vi.unstubAllGlobals();
      vi.stubGlobal('fetch', fetchMock);
    });
  });
});

describe('the earlier texts of an unfinished merge', () => {
  it('shows nothing more while the session holds only the texts on screen', async () => {
    await conflict();
    expect(heldTexts()).toBeNull();
    compare();
    intercept = (call) => (call.method === 'GET' ? reply(503) : undefined);
    await confirm();
    expect(screen.getByRole('alert').textContent).toContain('The merge could not be finished');
    expect(heldTexts()).toBeNull();
  });

  it('shows the other device’s earlier text once that device wrote again and the merged text was dismissed', async () => {
    const later = 'Le gardien chante. La mer monte.';
    await conflict();
    compare();
    // The first read fails: the other device's text is only in this tab.
    intercept = (call) => (call.method === 'GET' ? reply(503) : undefined);
    await confirm();
    intercept = () => undefined;
    // The other device writes again; this tab reads it, and the view takes it.
    otherDraft(later);
    queryClient.setQueryData(queryKeys.document('doc-1'), server());
    await elapse();
    expect(listed(heldTexts() as HTMLElement)).toEqual([['An earlier text from the other device', theirs]]);
    dismissPrevious();

    expect(view().querySelector('.reconcile-text')?.textContent).toContain('Added by Other device: chante');
    expect(listed(heldTexts() as HTMLElement)).toEqual([['An earlier text from the other device', theirs]]);
    await leaveAndComeBack();
    expect(listed(heldTexts() as HTMLElement)).toEqual([['An earlier text from the other device', theirs]]);

    // The next confirmation keeps it as a version: it is no longer listed.
    compare();
    await confirm();
    expect(revisions.map((revision) => revision.content)).toEqual(expect.arrayContaining([theirs, mine, later]));
    expect(server().draft?.content).toBe('Le gardien chante. La mer descend.');
    expect(heldTexts()).toBeNull();
  });

  it('shows the writer’s earlier text once they edited it after a failed confirmation, until they discard it', async () => {
    const edited = 'Le gardien dort. La mer descend vers le large.';
    await conflict();
    compare();
    intercept = (call) => (call.method === 'GET' ? reply(503) : undefined);
    await confirm();
    intercept = () => undefined;
    fireEvent.click(within(view()).getByRole('button', { name: 'Cancel' }));
    type(edited);

    expect(listed(heldTexts() as HTMLElement)).toEqual([['An earlier text of yours', mine]]);
    await leaveAndComeBack();
    expect(listed(heldTexts() as HTMLElement)).toEqual([['An earlier text of yours', mine]]);

    fireEvent.click(within(heldTexts() as HTMLElement).getByRole('button', { name: 'Discard this text' }));
    expect(heldTexts()).toBeNull();
    expect(textarea().value).toBe(edited);
  });
});
