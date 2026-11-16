import type {
  CreateDraftDocumentInput,
  Document,
  DocumentSummary,
  RenameDocumentInput,
  SaveDraftInput,
} from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, within, type RenderResult } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reachability } from '../api';
import { App } from '../App';
import { configureDeviceBuffer, type Locks } from '../autosave/deviceBuffer';
import {
  openLocalBuffer,
  type BufferEntry,
  type BufferFailureReason,
  type LocalBuffer,
  type LocalBufferOptions,
} from '../autosave/localBuffer';
import { abandonAutosave, entryOf } from '../autosave/useAutosave';
import { createQueryClient } from '../queryClient';

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

const original = 'Il veillait.';

let db: Map<string, Document>;
/** Every text the server ever saved as a draft or a document's first text. */
let everSaved: Set<string>;
/** Every creation the server ever accepted, kept after a deletion. */
let accepted: CreateDraftDocumentInput[];
/** The body of each creation the server took, by id: kept after a deletion, as the server keeps the id. */
let creations: Map<string, string>;

const error = (statusCode: number, message: string) => reply(statusCode, { statusCode, message });

/**
 * The API's rules for listing and reading documents, saving a draft and renaming; and for a creation: the same id and
 * body answer the document as it is now, another body is refused (422), and so is the id of a deleted document (410).
 */
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
    // A creation without an id ("Save as a new document") gets one from the server.
    const id = (input.id as string | undefined) ?? `made-${db.size + 1}`;
    const key = JSON.stringify([input.title ?? null, input.content, input.draftOnly]);
    const recorded = creations.get(id);
    if (recorded !== undefined) {
      if (recorded !== key) return error(422, `Document ${id} was already created with another body`);
      const existing = db.get(id);
      return existing === undefined ? error(410, `Document ${id} was deleted`) : reply(201, existing);
    }
    creations.set(id, key);
    everSaved.add(input.content);
    accepted.push(input);
    const created: Document = {
      id,
      title: input.title ?? null,
      revision: 0,
      content: '',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      draft: { content: input.content, draftVersion: 1, baseRevision: null },
    };
    db.set(id, created);
    return reply(201, created);
  }
  const [, , id, sub] = path.split('/');
  const document = id === undefined ? undefined : db.get(id);
  if (document?.draft === undefined) return notFound();
  const { draft } = document;
  if (method === 'GET' && sub === undefined) return reply(200, document);
  if (method === 'GET' && sub === 'revisions') return reply(200, []);
  if (method === 'PUT' && sub === 'draft') {
    const input = body as SaveDraftInput;
    if (draft.content === input.content) return reply(200, draft);
    if (draft.draftVersion !== input.draftVersion) {
      return reply(409, { statusCode: 409, message: 'Conflict', code: 'draft_conflict', draft });
    }
    const saved = { ...draft, content: input.content, draftVersion: draft.draftVersion + 1 };
    db.set(document.id, { ...document, draft: saved });
    everSaved.add(input.content);
    return reply(200, saved);
  }
  if (method === 'PATCH' && sub === undefined) {
    const { title } = body as RenameDocumentInput;
    const renamed = { ...document, title: title?.trim() ? title : null };
    db.set(document.id, renamed);
    return reply(200, renamed);
  }
  return notFound();
};

/** Another device saves a draft. */
const otherDraft = (content: string) => {
  const document = db.get('doc-1');
  if (document?.draft === undefined) throw new Error('No doc-1');
  db.set('doc-1', {
    ...document,
    draft: { ...document.draft, content, draftVersion: document.draft.draftVersion + 1 },
  });
};

const serverDraft = () => db.get('doc-1')?.draft?.content;

let calls: Call[];
/** Requests matching `lose` fail as a network error: the server is unreachable. */
let lose: (call: Call) => boolean;
/** Requests matching `loseAnswer` reach the server, but their answer is lost: the page sees a network error. */
let loseAnswer: (call: Call) => boolean;
/** Answers a request instead of the fake API, when it returns a response. */
let intercept: (call: Call) => Response | undefined;
/** Requests matching `hold` wait for `releaseHeld`. */
let hold: (call: Call) => boolean;
let held: (() => void)[];

const NAME = 'reviewr-test';
let factory: IDBFactory;
const bufferOptions = (): LocalBufferOptions => ({
  indexedDB: factory,
  name: NAME,
  // IndexedDB runs on real time here, the app on a fake clock: no timeout may fire while the clock jumps.
  openTimeoutMs: 600_000,
  transactionTimeoutMs: 600_000,
});

/** Lets IndexedDB (real time) and the app (fake time) run until both are idle. */
const settle = async () => {
  for (let round = 0; round < 12; round++) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1);
    });
  }
};

/** Lets `ms` go by on the app's clock, then everything that follows. */
const elapse = async (ms = 0) => {
  await settle();
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await settle();
};

const releaseHeld = async () => {
  hold = () => false;
  for (const answer of held.splice(0)) answer();
  await settle();
};

/** Writes and deletes records as another tab would, with its own connection. */
const raw = async (change: (buffer: LocalBuffer) => Promise<unknown>) => {
  const buffer = openLocalBuffer(bufferOptions());
  await act(async () => {
    await change(buffer);
    await buffer.close();
  });
};

/** What the buffer holds, read as another page would: each key with its text. */
const stored = async (): Promise<[string, string][]> => {
  let entries: [string, string][] = [];
  await raw(async (buffer) => {
    const result = await buffer.list();
    entries = result.entries.map(({ key, content }) => [key, content]);
  });
  return entries.sort(([a], [b]) => a.localeCompare(b));
};

/** Which simulated tab holds each lock. A crash releases a tab's locks and drops the requests it was waiting on. */
let heldLocks: Map<string, number>;
/** While set, requests for another tab's lock (`ifAvailable`) wait for `grantClaims`. */
let claimsWait: boolean;
let pendingClaims: { tab: number; grant: () => void }[];
let tabs: number;
/** The pages opened in this test: whatever they still hold stops with the test, so no machine saves into the next. */
const opened: QueryClient[] = [];

const locksOf = (tab: number): Locks => ({
  request: (name: string, ...rest: unknown[]) => {
    const callback = rest.at(-1) as (lock: Lock | null) => unknown;
    const options = (rest.length > 1 ? rest[0] : {}) as LockOptions;
    // Decided when granted, on the locks held then.
    const decide = (): unknown => {
      if (heldLocks.has(name)) return options.ifAvailable === true ? callback(null) : new Promise(() => {});
      heldLocks.set(name, tab);
      return callback({ name, mode: 'exclusive' });
    };
    if (options.ifAvailable === true && claimsWait) {
      return new Promise<unknown>((resolve) => pendingClaims.push({ tab, grant: () => resolve(decide()) }));
    }
    return Promise.resolve(decide());
  },
});

const grantClaims = async () => {
  claimsWait = false;
  for (const { grant } of pendingClaims.splice(0)) grant();
  await settle();
};

/** Faults a page's buffer answers instead of writing. */
interface Faults {
  put?: BufferFailureReason;
  delete?: BufferFailureReason;
}

/**
 * A page's buffer as a crash sees it: calls reach IndexedDB one at a time, so on a crash the calls not sent yet are
 * dropped (only committed records stay), and no answer reaches the page any more. `pause` keeps calls from being sent.
 */
interface CrashableBuffer extends LocalBuffer {
  faults: Faults;
  pause: () => void;
  resume: () => void;
  crash: () => void;
}

const crashable = (real: LocalBuffer = openLocalBuffer(bufferOptions())): CrashableBuffer => {
  let crashed = false;
  let paused = false;
  let running = false;
  const queue: (() => Promise<void>)[] = [];
  const pump = async () => {
    if (running) return;
    running = true;
    for (let job = queue.shift(); job !== undefined && !crashed; job = paused ? undefined : queue.shift()) await job();
    running = false;
    if (!paused && !crashed && queue.length > 0) void pump();
  };
  const call = <T,>(run: () => Promise<T>) =>
    new Promise<T>((resolve) => {
      if (crashed) return;
      queue.push(async () => {
        const result = await run();
        if (!crashed) resolve(result);
      });
      if (!paused) void pump();
    });
  const failure = (reason: BufferFailureReason) => ({ ok: false as const, reason, error: new Error(reason) });
  const buffer: CrashableBuffer = {
    faults: {},
    get: (key) => call(() => real.get(key)),
    list: () => call(() => real.list()),
    put: (key, value) => {
      const record = { content: value.content, base: value.base, page: value.page };
      return call(() => (buffer.faults.put ? Promise.resolve(failure(buffer.faults.put)) : real.put(key, record)));
    },
    delete: (key, condition) =>
      call(() =>
        buffer.faults.delete
          ? Promise.resolve({ ...failure(buffer.faults.delete), deleted: false as const })
          : real.delete(key, condition),
      ),
    close: () => real.close(),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      void pump();
    },
    crash: () => {
      crashed = true;
      queue.length = 0;
    },
  };
  return buffer;
};

interface Page {
  queryClient: QueryClient;
  view: RenderResult;
  buffer: CrashableBuffer | null;
  /** The page goes away at once, as when the browser crashes: nothing more is sent, written or answered. */
  crash: () => Promise<void>;
}

interface LoadOptions {
  buffer?: LocalBuffer | null;
  locks?: boolean;
  strict?: boolean;
}

/** Opens the app in a new tab, at `hash`, on the same IndexedDB as the tabs before it. */
const load = async (hash = '#/documents/doc-1', options: LoadOptions = {}) => {
  window.history.replaceState(null, '', `/${hash}`);
  const tab = ++tabs;
  const buffer = options.buffer === null ? null : crashable(options.buffer);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false } });
  configureDeviceBuffer(queryClient, {
    buffer,
    locks: options.locks === false ? null : locksOf(tab),
    tabId: `tab-${tab}`,
  });
  const app = (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
  const view = render(options.strict === true ? <StrictMode>{app}</StrictMode> : app);
  const page: Page = {
    queryClient,
    view,
    buffer,
    crash: async () => {
      buffer?.crash();
      abandonAutosave(queryClient);
      for (const [name, owner] of heldLocks) if (owner === tab) heldLocks.delete(name);
      pendingClaims = pendingClaims.filter((claim) => claim.tab !== tab);
      view.unmount();
      await settle();
    },
  };
  opened.push(queryClient);
  await elapse();
  return page;
};

const textOf = (page: Page) => page.view.container.querySelector<HTMLTextAreaElement>('textarea.content-input');
const textarea = (page: Page) => {
  const field = textOf(page);
  if (field === null) throw new Error('No text field');
  return field;
};
const type = (page: Page, value: string) => fireEvent.change(textarea(page), { target: { value } });
const notice = (page: Page) => within(page.view.container).queryByText('No copy kept on this device');
/** The texts listed as held: each label with its text. */
const listed = (page: Page) =>
  [...page.view.container.querySelectorAll<HTMLElement>('.held-text')].map((section) => [
    section.querySelector('h3')?.textContent,
    section.querySelector('textarea')?.value,
  ]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const now = '2026-11-01T10:00:00.000Z';
  db = new Map(
    (['doc-1', 'doc-2'] as const).map((id) => [
      id,
      {
        id,
        title: id === 'doc-1' ? 'Le gardien du phare' : 'Lettres',
        revision: 1,
        content: original,
        createdAt: now,
        updatedAt: now,
        draft: { content: original, draftVersion: 1, baseRevision: 1 },
      },
    ]),
  );
  everSaved = new Set();
  creations = new Map();
  accepted = [];
  calls = [];
  lose = () => false;
  loseAnswer = () => false;
  intercept = () => undefined;
  hold = () => false;
  held = [];
  factory = new IDBFactory();
  heldLocks = new Map();
  claimsWait = false;
  pendingClaims = [];
  tabs = 0;

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
    if (lose(call)) return Promise.reject(new TypeError('Failed to fetch'));
    const intercepted = intercept(call);
    if (intercepted !== undefined) return Promise.resolve(intercepted);
    if (loseAnswer(call)) {
      fakeApi(call);
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (hold(call)) return new Promise<Response>((resolve) => held.push(() => resolve(fakeApi(call))));
    return Promise.resolve(fakeApi(call));
  });
});

afterEach(async () => {
  for (const queryClient of opened.splice(0)) abandonAutosave(queryClient);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
  vi.restoreAllMocks();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

const isDraftSave = (call: Call) => call.method === 'PUT' && call.path.endsWith('/draft');
const isCreation = (call: Call) => call.method === 'POST' && call.path === '/documents';

describe('the local buffer, in one tab', () => {
  it('keeps every edit with its base, and deletes it once the server confirmed that very text', async () => {
    const page = await load();
    type(page, 'Il veillait sur la mer.');
    await settle();
    expect(await stored()).toEqual([['tab-1 doc-1', 'Il veillait sur la mer.']]);

    await elapse(1000);
    expect(serverDraft()).toBe('Il veillait sur la mer.');
    expect(await stored()).toEqual([]);
    expect(notice(page)).toBeNull();
  });

  it('never deletes a newer text on the confirmation of an older one', async () => {
    const page = await load();
    hold = isDraftSave;
    type(page, 'Il veillait');
    await elapse(1000);
    expect(held).toHaveLength(1);
    type(page, 'Il veillait sur la mer.');
    await settle();

    // The older text is confirmed: the newer one is sent, and stays in the buffer meanwhile.
    hold = isDraftSave;
    const first = held.splice(0);
    for (const answer of first) answer();
    await settle();
    expect(serverDraft()).toBe('Il veillait');
    expect(await stored()).toEqual([['tab-1 doc-1', 'Il veillait sur la mer.']]);

    await releaseHeld();
    expect(serverDraft()).toBe('Il veillait sur la mer.');
    expect(await stored()).toEqual([]);
  });

  it('brings the text back after a crash, before the server’s text is shown, and saves it', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Il veillait, seul.');
    await elapse(1000);
    await first.crash();
    expect(serverDraft()).toBe(original);

    lose = () => false;
    const second = await load();
    expect(textarea(second).value).toBe('Il veillait, seul.');
    await elapse(1000);
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(await stored()).toEqual([]);
  });

  it('keeps the text through a reload while the server is unreachable, and saves it once it is back', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    lose = () => true;
    const second = await load();
    // Nothing is decided without the server's draft: the text waits in the buffer, where the crashed tab left it.
    expect(within(second.view.container).getByText('This document will open as soon as the server is back.'));
    expect(textOf(second)).toBeNull();
    expect(listed(second)).toEqual([['Another copy kept on this device', 'Hors ligne.']]);
    expect(await stored()).toEqual([['tab-1 doc-1', 'Hors ligne.']]);
    // The first tab's one attempt: the second sends nothing before it can read the server.
    expect(calls.filter(isDraftSave)).toHaveLength(1);

    lose = () => false;
    await elapse(5000);
    await elapse(1000);
    expect(serverDraft()).toBe('Hors ligne.');
    expect(textarea(second).value).toBe('Hors ligne.');
    expect(await stored()).toEqual([]);
  });

  it('shows a conflict when the server moved meanwhile, merged against the base the text was written from', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Il veillait, seul.');
    await elapse(1000);
    await first.crash();
    otherDraft('Elle veillait.');

    lose = () => false;
    const second = await load();
    await elapse(1000);
    expect(within(second.view.container).getByRole('alert').textContent).toContain(
      'This text was also changed on another device.',
    );
    const state = entryOf(second.queryClient, 'doc-1')?.autosave.getSnapshot();
    expect(state?.status).toBe('conflict');
    // The reconciliation's three texts.
    expect(state?.base.content).toBe(original);
    expect(state?.content).toBe('Il veillait, seul.');
    expect(state?.status === 'conflict' && state.server.content).toBe('Elle veillait.');
    expect(serverDraft()).toBe('Elle veillait.');
    expect(await stored()).toEqual([['tab-2 doc-1', 'Il veillait, seul.']]);
  });

  it('lists the text for recovery when the document was deleted meanwhile, until the writer discards it', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Il veillait, seul.');
    await elapse(1000);
    await first.crash();
    db.delete('doc-1');

    lose = () => false;
    const second = await load();
    await elapse(1000);
    expect(within(second.view.container).getByRole('heading', { name: 'This document was deleted elsewhere' }));
    expect(listed(second)).toEqual([['Your text', 'Il veillait, seul.']]);
    expect(await stored()).toEqual([['tab-2 doc-1', 'Il veillait, seul.']]);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(second.view.container).getByRole('button', { name: 'Discard these copies' }));
    await settle();
    expect(await stored()).toEqual([]);
  });

  it('holds a text that is its own base as a copy, and sends nothing, when the server moved', async () => {
    // A tab that crashed while a save was unanswered, after the writer typed the text back to its base.
    await raw((buffer) =>
      buffer.put('tab-0 doc-1', { content: original, base: { content: original, draftVersion: 1 } }),
    );
    otherDraft('Il veillait, seul.');

    const page = await load();
    await elapse(1000);
    expect(textarea(page).value).toBe('Il veillait, seul.');
    expect(listed(page)).toEqual([['Another copy kept on this device', original]]);
    expect(calls.filter(isDraftSave)).toEqual([]);
    expect(await stored()).toEqual([['tab-0 doc-1', original]]);
  });

  it('holds a text whose base is ahead of the server as a copy, without sending it in a loop', async () => {
    await raw((buffer) =>
      buffer.put('tab-0 doc-1', { content: 'Venu d’ailleurs.', base: { content: 'Autre', draftVersion: 100 } }),
    );
    const page = await load();
    await elapse(5000);
    expect(textarea(page).value).toBe(original);
    expect(listed(page)).toEqual([['Another copy kept on this device', 'Venu d’ailleurs.']]);
    expect(calls.filter(isDraftSave)).toEqual([]);
    expect(serverDraft()).toBe(original);

    fireEvent.click(within(page.view.container).getByRole('button', { name: 'Discard this copy' }));
    await settle();
    expect(await stored()).toEqual([]);
  });

  it('lets go of a text the server already holds', async () => {
    await raw((buffer) =>
      buffer.put('tab-0 doc-1', { content: original, base: { content: 'Avant', draftVersion: 0 } }),
    );
    const page = await load();
    await elapse(1000);
    expect(textarea(page).value).toBe(original);
    expect(listed(page)).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('saves in the background a text restored for a document that is not open', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Il veillait, seul.');
    await elapse(1000);
    await first.crash();

    lose = () => false;
    const second = await load('');
    await elapse(1000);
    expect(textarea(second).value).toBe('');
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(await stored()).toEqual([]);
    expect(entryOf(second.queryClient, 'doc-1')).toBeUndefined();
  });

  it('shows nothing of the document while the buffer is slow to answer, and loses no keystroke after', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Il veillait, seul.');
    await elapse(1000);
    await first.crash();

    lose = () => false;
    const real = openLocalBuffer(bufferOptions());
    let slowness = true;
    const waiting: (() => void)[] = [];
    const slow: LocalBuffer = {
      ...real,
      list: () =>
        slowness ? new Promise((resolve) => waiting.push(() => void real.list().then(resolve))) : real.list(),
    };
    const answer = () => {
      slowness = false;
      for (const run of waiting.splice(0)) run();
    };
    const second = await load('#/documents/doc-1', { buffer: slow });
    await elapse(3000);
    expect(textOf(second)).toBeNull();
    expect(within(second.view.container).getByText('Loading…'));
    expect(second.view.container.textContent).not.toContain(original);

    answer();
    await settle();
    expect(textarea(second).value).toBe('Il veillait, seul.');
    type(second, 'Il veillait, seul, la nuit.');
    await elapse(1000);
    expect(serverDraft()).toBe('Il veillait, seul, la nuit.');
    expect(await stored()).toEqual([]);
  });
});

describe('when the buffer cannot keep the text', () => {
  /** A buffer that answers every call with `reason`. */
  const failing = (reason: BufferFailureReason): LocalBuffer => {
    const failure = { ok: false as const, reason, error: new Error(reason) };
    return {
      get: () => Promise.resolve({ ...failure, entry: undefined }),
      put: () => Promise.resolve(failure),
      delete: () => Promise.resolve({ ...failure, deleted: false }),
      list: () => Promise.resolve({ ...failure, entries: [] }),
      close: () => Promise.resolve(),
    };
  };

  it.each<BufferFailureReason>(['unavailable', 'blocked', 'quota', 'failed', 'stalled'])(
    'says so once (%s), and typing and saving go on',
    async (reason) => {
      const page = await load('#/documents/doc-1', { buffer: failing(reason) });
      expect(notice(page)).not.toBeNull();
      type(page, 'Il veillait sur la mer.');
      await elapse(1000);
      expect(textarea(page).value).toBe('Il veillait sur la mer.');
      expect(serverDraft()).toBe('Il veillait sur la mer.');

      fireEvent.click(within(page.view.container).getByRole('button', { name: 'OK' }));
      type(page, 'Il veillait sur la mer, seul.');
      await elapse(1000);
      expect(notice(page)).toBeNull();
      expect(textarea(page).value).toBe('Il veillait sur la mer, seul.');
      expect(serverDraft()).toBe('Il veillait sur la mer, seul.');
    },
  );

  it('says so when a write fails mid-way, and keeps the text in memory', async () => {
    const real = openLocalBuffer(bufferOptions());
    let full = false;
    const buffer: LocalBuffer = {
      ...real,
      put: (key, value) =>
        full ? Promise.resolve({ ok: false, reason: 'quota', error: new Error('full') }) : real.put(key, value),
    };
    lose = isDraftSave;
    const page = await load('#/documents/doc-1', { buffer });
    type(page, 'Il veillait');
    await settle();
    expect(notice(page)).toBeNull();
    full = true;
    type(page, 'Il veillait sur la mer.');
    await elapse(1000);
    expect(notice(page)).not.toBeNull();
    expect(within(page.view.container).getByText(/storage is full/));
    expect(textarea(page).value).toBe('Il veillait sur la mer.');

    lose = () => false;
    await elapse(2000);
    expect(serverDraft()).toBe('Il veillait sur la mer.');
    // The older text the buffer still held goes with the confirmation.
    expect(await stored()).toEqual([]);
  });

  it('says so without IndexedDB, and opens documents at once', async () => {
    const page = await load('#/documents/doc-1', { buffer: null });
    expect(notice(page)).not.toBeNull();
    expect(textarea(page).value).toBe(original);
  });
});

describe('two tabs on one document', () => {
  it('keeps each tab’s text after both crash: the latest is the text, the other a copy until discarded', async () => {
    lose = isDraftSave;
    const one = await load();
    const two = await load();
    type(one, 'Le texte du premier onglet.');
    await settle();
    type(two, 'Le texte du second onglet.');
    await elapse(1000);
    expect(await stored()).toEqual([
      ['tab-1 doc-1', 'Le texte du premier onglet.'],
      ['tab-2 doc-1', 'Le texte du second onglet.'],
    ]);
    await one.crash();
    await two.crash();

    lose = () => false;
    const three = await load();
    await elapse(1000);
    expect(textarea(three).value).toBe('Le texte du second onglet.');
    expect(listed(three)).toEqual([['Another copy kept on this device', 'Le texte du premier onglet.']]);
    expect(serverDraft()).toBe('Le texte du second onglet.');
    expect(await stored()).toEqual([['tab-1 doc-1', 'Le texte du premier onglet.']]);

    fireEvent.click(within(three.view.container).getByRole('button', { name: 'Discard this copy' }));
    await settle();
    expect(listed(three)).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('brings a copy left alone back as the text after another reload, as a conflict with the server', async () => {
    lose = isDraftSave;
    const one = await load();
    const two = await load();
    type(one, 'Le texte du premier onglet.');
    await settle();
    type(two, 'Le texte du second onglet.');
    await elapse(1000);
    await one.crash();
    await two.crash();
    lose = () => false;
    const three = await load();
    await elapse(1000);
    await three.crash();

    const four = await load();
    await elapse(1000);
    const state = entryOf(four.queryClient, 'doc-1')?.autosave.getSnapshot();
    expect(state?.status).toBe('conflict');
    expect(state?.base.content).toBe(original);
    expect(state?.content).toBe('Le texte du premier onglet.');
    expect(state?.status === 'conflict' && state.server.content).toBe('Le texte du second onglet.');
    expect(serverDraft()).toBe('Le texte du second onglet.');
  });

  it('drops a copy once the text saved is that copy', async () => {
    lose = isDraftSave;
    const one = await load();
    const two = await load();
    type(one, 'Le texte du premier onglet.');
    await settle();
    type(two, 'Le texte du second onglet.');
    await elapse(1000);
    await one.crash();
    await two.crash();

    lose = () => false;
    const three = await load();
    await elapse(1000);
    type(three, 'Le texte du premier onglet.');
    await elapse(1000);
    expect(listed(three)).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('never takes the text of a tab that is still open', async () => {
    lose = isDraftSave;
    const one = await load();
    type(one, 'Le texte du premier onglet.');
    await elapse(1000);

    const two = await load();
    await elapse(1000);
    expect(textarea(two).value).toBe(original);
    expect(listed(two)).toEqual([]);
    expect(await stored()).toEqual([['tab-1 doc-1', 'Le texte du premier onglet.']]);

    // Once the first tab crashed, opening the document again in the second brings its text back.
    await one.crash();
    fireEvent.click(within(two.view.container).getByRole('button', { name: /Lettres/ }));
    await elapse();
    fireEvent.click(within(two.view.container).getByRole('button', { name: /Le gardien du phare/ }));
    await elapse();
    expect(textarea(two).value).toBe('Le texte du premier onglet.');
    expect(listed(two)).toEqual([]);
  });
});

describe('adoption, through crashes and races', () => {
  /** The first tab types `text`, which the server never gets, then crashes. */
  const leave = async (text = 'Il veillait, seul.') => {
    lose = isDraftSave;
    const first = await load();
    type(first, text);
    await elapse(1000);
    await first.crash();
  };

  it('keeps a gone tab’s text when its replacement write fails, through a crash before the server has it', async () => {
    await leave();
    const failing = crashable();
    failing.faults.put = 'quota';
    const second = await load('#/documents/doc-1', { buffer: failing });
    await elapse(1000);
    expect(textarea(second).value).toBe('Il veillait, seul.');
    expect(notice(second)).not.toBeNull();
    // Not written elsewhere, not confirmed: the gone tab's entry stays.
    expect(await stored()).toEqual([['tab-1 doc-1', 'Il veillait, seul.']]);
    await second.crash();

    lose = () => false;
    const third = await load();
    await elapse(1000);
    expect(textarea(third).value).toBe('Il veillait, seul.');
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(await stored()).toEqual([]);
  });

  it('decides on records read under the owner’s lock: a text undone and deleted meanwhile is not restored', async () => {
    // Another tab, still open, holds an unsaved text.
    await raw((buffer) =>
      buffer.put('tab-A doc-1', { content: 'Il veillait, seul.', base: { content: original, draftVersion: 1 } }),
    );
    heldLocks.set('reviewr-tab tab-A', 99);
    claimsWait = true;
    lose = () => false;
    const page = await load();
    expect(textOf(page)).toBeNull();

    // Between the list and the lock: that tab goes back to the saved text, deletes its entry, and closes.
    await raw((buffer) => buffer.delete('tab-A doc-1'));
    heldLocks.delete('reviewr-tab tab-A');
    await grantClaims();
    await elapse(1000);
    expect(textarea(page).value).toBe(original);
    expect(calls.filter(isDraftSave)).toEqual([]);
    expect(serverDraft()).toBe(original);
  });

  it('restores the newest text a tab wrote before it closed, not the one listed first', async () => {
    await raw((buffer) =>
      buffer.put('tab-A doc-1', { content: 'Il veillait', base: { content: original, draftVersion: 1 } }),
    );
    heldLocks.set('reviewr-tab tab-A', 99);
    claimsWait = true;
    const page = await load();
    await raw((buffer) =>
      buffer.put('tab-A doc-1', { content: 'Il veillait, seul.', base: { content: original, draftVersion: 1 } }),
    );
    heldLocks.delete('reviewr-tab tab-A');
    await grantClaims();
    await elapse(1000);
    expect(textarea(page).value).toBe('Il veillait, seul.');
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(await stored()).toEqual([]);
  });

  it('keeps the text when the adopting tab crashes while waiting for the lock', async () => {
    await leave();
    claimsWait = true;
    const second = await load();
    await second.crash();
    claimsWait = false;

    lose = () => false;
    const third = await load();
    await elapse(1000);
    expect(textarea(third).value).toBe('Il veillait, seul.');
    expect(serverDraft()).toBe('Il veillait, seul.');
  });

  it('keeps the text when the adopting tab crashes before its replacement write is sent', async () => {
    await leave();
    // The read of the document waits, so the restore (and its write) comes after the buffer is paused.
    hold = (call) => call.method === 'GET' && call.path === '/documents/doc-1';
    const second = await load();
    second.buffer?.pause();
    await releaseHeld();
    await elapse(1000);
    expect(textarea(second).value).toBe('Il veillait, seul.');
    await second.crash();

    lose = () => false;
    const third = await load();
    await elapse(1000);
    expect(textarea(third).value).toBe('Il veillait, seul.');
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(await stored()).toEqual([]);
  });

  it('keeps a text that two living tabs without Web Locks each adopted from the other', async () => {
    lose = isDraftSave;
    const one = await load('#/documents/doc-1', { locks: false });
    type(one, 'Il veillait, seul.');
    await elapse(1000);
    // Without Web Locks, the second tab takes the first one's text over, though that tab is still open.
    const two = await load('#/documents/doc-1', { locks: false });
    await elapse(1000);
    expect(textarea(two).value).toBe('Il veillait, seul.');
    // The first tab looks for texts left again, and finds the second tab's copy of its own text.
    act(() => {
      reachability.reportError(new TypeError('Failed to fetch'));
      reachability.reportSuccess();
    });
    await elapse(1000);
    // Neither copy went for the other's sake: a tab's own write stands for another's copy only under its lock.
    expect((await stored()).map(([, text]) => text)).toEqual(['Il veillait, seul.', 'Il veillait, seul.']);
    await one.crash();
    await two.crash();

    lose = () => false;
    const three = await load();
    await elapse(1000);
    expect(textarea(three).value).toBe('Il veillait, seul.');
    expect(serverDraft()).toBe('Il veillait, seul.');
  });

  it('restores without Web Locks', async () => {
    lose = isDraftSave;
    const first = await load('#/documents/doc-1', { locks: false });
    type(first, 'Il veillait, seul.');
    await elapse(1000);
    await first.crash();

    lose = () => false;
    const second = await load('#/documents/doc-1', { locks: false });
    await elapse(1000);
    expect(textarea(second).value).toBe('Il veillait, seul.');
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(await stored()).toEqual([]);
  });

  it('lets go of an entry whose delete failed once the server is seen to hold its text', async () => {
    const failing = crashable();
    failing.faults.delete = 'failed';
    const first = await load('#/documents/doc-1', { buffer: failing });
    type(first, 'Il veillait, seul.');
    await elapse(1000);
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(notice(first)).not.toBeNull();
    expect(await stored()).toEqual([['tab-1 doc-1', 'Il veillait, seul.']]);
    await first.crash();

    const second = await load();
    await elapse(1000);
    expect(textarea(second).value).toBe('Il veillait, seul.');
    expect(within(second.view.container).queryByRole('alert')).toBeNull();
    expect(await stored()).toEqual([]);
  });

  it('restores once in strict mode', async () => {
    await leave();
    lose = () => false;
    const second = await load('#/documents/doc-1', { strict: true });
    await elapse(1000);
    expect(textarea(second).value).toBe('Il veillait, seul.');
    expect(listed(second)).toEqual([]);
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(calls.filter(isDraftSave).filter((call) => call.method === 'PUT')).toHaveLength(2);
    expect(await stored()).toEqual([]);
  });

  it('keeps the text typed during a document’s creation once the creation is confirmed', async () => {
    hold = (call) => call.method === 'POST' && call.path === '/documents';
    const first = await load('');
    type(first, 'Une page.');
    await elapse(1000);
    expect(held).toHaveLength(1);
    type(first, 'Une page neuve.');
    await settle();
    const { id: created } = calls.find(isCreation)?.body as CreateDraftDocumentInput;
    expect(await stored()).toEqual([[`tab-1 ${created}`, 'Une page neuve.']]);

    lose = isDraftSave;
    await releaseHeld();
    await elapse(1000);
    const id = [...db.keys()].find((key) => key !== 'doc-1' && key !== 'doc-2') ?? '';
    expect(db.get(id)?.draft?.content).toBe('Une page.');
    expect(await stored()).toEqual([[`tab-1 ${id}`, 'Une page neuve.']]);
    await first.crash();

    lose = () => false;
    const second = await load(`#/documents/${id}`);
    await elapse(1000);
    expect(textarea(second).value).toBe('Une page neuve.');
    expect(db.get(id)?.draft?.content).toBe('Une page neuve.');
    expect(db.size).toBe(3);
  });

  it('brings back the last text whose write committed when a crash drops the newest one, queued', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Il veillait');
    await settle();
    first.buffer?.pause();
    type(first, 'Il veillait, seul.');
    await settle();
    await first.crash();

    lose = () => false;
    const second = await load();
    await elapse(1000);
    expect(textarea(second).value).toBe('Il veillait');
    expect(serverDraft()).toBe('Il veillait');
  });
});

describe('the invariant of adoption, on random runs', () => {
  /** A small seeded generator (mulberry32), so a failing run can be replayed. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it.each(Array.from({ length: 12 }, (_, i) => i + 1))('loses no text a tab left, run %i', async (seed) => {
    const next = random(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    interface Tab {
      page: Page;
      /** The tab's last text, which must survive it unless its buffer refused to keep it. */
      last?: string;
      keeps: boolean;
    }
    const open: Tab[] = [];
    const left: string[] = [];
    let words = 0;
    for (let step = 0; step < 14; step++) {
      const roll = next();
      if (open.length === 0 || (roll < 0.2 && open.length < 3)) {
        const keeps = next() > 0.15;
        const buffer = crashable();
        if (!keeps) buffer.faults.put = 'quota';
        claimsWait = next() < 0.3;
        const page = await load('#/documents/doc-1', { buffer });
        await grantClaims();
        await elapse(100);
        open.push({ page, keeps });
      } else if (roll < 0.6) {
        const tab = pick(open);
        if (textOf(tab.page) === null) continue;
        // A text this tab took over from a gone one is superseded by the writer's edit of it, in this tab.
        const before = textarea(tab.page).value;
        left.splice(0, left.length, ...left.filter((text) => text !== before));
        tab.last = `${before} mot${++words}`;
        type(tab.page, tab.last);
        await settle();
        await elapse(pick([0, 300, 1200]));
      } else if (roll < 0.75) {
        lose = next() < 0.5 ? isDraftSave : () => false;
        await elapse(pick([0, 1000]));
      } else {
        const tab = pick(open);
        open.splice(open.indexOf(tab), 1);
        if (tab.last !== undefined && tab.keeps) left.push(tab.last);
        await tab.page.crash();
      }
    }
    for (const tab of open) {
      if (tab.last !== undefined && tab.keeps) left.push(tab.last);
      await tab.page.crash();
    }

    lose = () => false;
    claimsWait = false;
    const last = await load();
    await elapse(5000);
    await elapse(5000);
    const onScreen = [textOf(last)?.value, ...listed(last).map(([, text]) => text)];
    const inBuffer = (await stored()).map(([, text]) => text);
    for (const text of left) {
      expect(everSaved.has(text) || onScreen.includes(text) || inBuffer.includes(text), text).toBe(true);
    }
  });
});

describe('texts kept while their restore waits, and leaving the page', () => {
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const openDocument = async (page: Page, name: RegExp) => {
    fireEvent.click(within(page.view.container).getByRole('button', { name }));
    await elapse(1000);
  };

  it('shows a text left by a crashed tab, to copy, through a long outage, then recovers it once', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    lose = () => true;
    const second = await load();
    await elapse(60_000);
    expect(textOf(second)).toBeNull();
    expect(listed(second)).toEqual([['Another copy kept on this device', 'Hors ligne.']]);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(within(second.view.container).getByRole('button', { name: 'Copy' }));
    await settle();
    expect(writeText).toHaveBeenCalledWith('Hors ligne.');
    Reflect.deleteProperty(navigator, 'clipboard');
    expect(calls.filter(isDraftSave)).toHaveLength(1);

    // The registry tries again on its own, its backoff capped at a minute.
    lose = () => false;
    await elapse(30_000);
    await elapse(1000);
    expect(textarea(second).value).toBe('Hors ligne.');
    expect(listed(second)).toEqual([]);
    expect(serverDraft()).toBe('Hors ligne.');
    expect(await stored()).toEqual([]);
    expect(unload()).toBe(false);
  });

  it('warns on leaving while a restore waits for the server, also from another document', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    lose = (call) => call.path.startsWith('/documents/doc-1');
    const second = await load();
    expect(listed(second)).toEqual([['Another copy kept on this device', 'Hors ligne.']]);
    expect(unload()).toBe(true);
    await openDocument(second, /Lettres/);
    expect(textarea(second).value).toBe(original);
    expect(unload()).toBe(true);
    // Only this read fails: it is tried again now and then, not in a loop.
    const reads = () => calls.filter((call) => call.method === 'GET' && call.path === '/documents/doc-1').length;
    const before = reads();
    await elapse(10_000);
    expect(reads() - before).toBeLessThan(4);
  });

  it('warns on leaving while a copy the server does not have is held, until it is discarded', async () => {
    await raw((buffer) =>
      buffer.put('tab-0 doc-1', { content: 'Venu d’ailleurs.', base: { content: 'Autre', draftVersion: 100 } }),
    );
    const page = await load();
    await elapse(1000);
    expect(listed(page)).toEqual([['Another copy kept on this device', 'Venu d’ailleurs.']]);
    expect(unload()).toBe(true);
    await openDocument(page, /Lettres/);
    expect(unload()).toBe(true);

    await openDocument(page, /Le gardien du phare/);
    fireEvent.click(within(page.view.container).getByRole('button', { name: 'Discard this copy' }));
    await settle();
    expect(unload()).toBe(false);
  });
});

describe('the waiting texts, kept in line with the buffer', () => {
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const isDocumentRead = (id: string) => (call: Call) => call.method === 'GET' && call.path === `/documents/${id}`;

  it('recovers a waiting text of a document that is not open, though the server never looked unreachable', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    // Only the read of the left document fails; the open one works, so the server always looks reachable.
    lose = isDocumentRead('doc-1');
    const second = await load('#/documents/doc-2');
    await elapse(1000);
    expect(textarea(second).value).toBe(original);
    expect(unload()).toBe(true);
    expect(reachability.isUnreachable()).toBe(false);

    lose = () => false;
    await elapse(5000);
    await elapse(10_000);
    expect(reachability.isUnreachable()).toBe(false);
    expect(serverDraft()).toBe('Hors ligne.');
    expect(await stored()).toEqual([]);
    expect(unload()).toBe(false);
  });

  it('stops trying when the app is removed from the page, and recovers the text once it is shown again', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    lose = isDocumentRead('doc-1');
    const second = await load('#/documents/doc-2');
    await elapse(1000);
    expect(unload()).toBe(true);

    // The app goes away without the page going away, as on a hot reload: nothing may read or save behind it, even
    // once the document can be read again and well past the longest wait between two tries.
    second.view.unmount();
    await settle();
    lose = () => false;
    const sent = calls.length;
    await elapse(200_000);
    expect(calls).toHaveLength(sent);
    expect(serverDraft()).toBe(original);
    expect((await stored()).map(([, text]) => text)).toEqual(['Hors ligne.']);

    // Shown again on the same registry, the recovery goes on.
    render(
      <QueryClientProvider client={second.queryClient}>
        <App />
      </QueryClientProvider>,
    );
    await elapse(1000);
    await elapse(10_000);
    expect(serverDraft()).toBe('Hors ligne.');
    expect(await stored()).toEqual([]);
    expect(unload()).toBe(false);
  });

  it('drops a waiting text once another tab saved it and removed it from the buffer', async () => {
    lose = isDraftSave;
    const first = await load('#/documents/doc-1', { locks: false });
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    lose = isDocumentRead('doc-1');
    const waiting = await load('#/documents/doc-2', { locks: false });
    await elapse(100);
    expect(unload()).toBe(true);

    // Before the waiting tab tries again, another tab (no lock either) adopts the text, saves it and removes it.
    lose = () => false;
    const other = await load('#/documents/doc-1', { locks: false });
    await elapse(1000);
    expect(textarea(other).value).toBe('Hors ligne.');
    expect(serverDraft()).toBe('Hors ligne.');
    expect(await stored()).toEqual([]);
    other.view.unmount();
    // The tabs share this test's address: the waiting tab's is put back.
    window.history.replaceState(null, '', '/#/documents/doc-2');

    await elapse(5000);
    await elapse(1000);
    expect(unload()).toBe(false);
    fireEvent.click(within(waiting.view.container).getByRole('button', { name: /Le gardien du phare/ }));
    await elapse(1000);
    expect(textarea(waiting).value).toBe('Hors ligne.');
    expect(listed(waiting)).toEqual([]);
  });

  it('keeps a waiting text when a later scan of the buffer fails', async () => {
    lose = isDraftSave;
    const first = await load();
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    lose = isDocumentRead('doc-1');
    const buffer = crashable();
    const page = await load('#/documents/doc-2', { buffer });
    await elapse(100);
    expect(unload()).toBe(true);
    const list = buffer.list.bind(buffer);
    buffer.list = () => Promise.resolve({ ok: false, reason: 'failed', error: new Error('failed'), entries: [] });
    await elapse(5000);
    await elapse(1000);
    expect(unload()).toBe(true);

    buffer.list = list;
    lose = () => false;
    await elapse(10_000);
    await elapse(1000);
    expect(serverDraft()).toBe('Hors ligne.');
    expect(unload()).toBe(false);
    expect(textarea(page).value).toBe(original);
  });
});

describe('a page whose document does not exist yet', () => {
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  /** The documents created from pages. */
  const created = () => [...db.values()].filter((document) => document.id !== 'doc-1' && document.id !== 'doc-2');
  /** Their drafts, sorted. */
  const pages = () =>
    created()
      .map((document) => document.draft?.content)
      .sort();
  const creationsSent = () => calls.filter(isCreation).map((call) => call.body as CreateDraftDocumentInput);
  /** Every creation sent for one id had the same body. */
  const oneBodyPerId = () => {
    const bodies = new Map<string, Set<string>>();
    for (const { id, content } of creationsSent()) bodies.set(id, (bodies.get(id) ?? new Set()).add(content));
    return [...bodies.values()].every((set) => set.size === 1);
  };
  /** Every record of the buffer, as stored. */
  const records = async () => {
    let entries: BufferEntry[] = [];
    await raw(async (buffer) => {
      entries = (await buffer.list()).entries;
    });
    return entries.map(({ key, content, base, page }) => ({ key, content, base, page }));
  };
  const titleField = (page: Page) => page.view.container.querySelector<HTMLInputElement>('.title-input');
  /** Whether the page shows the recovery of a document deleted elsewhere. */
  const recovering = (page: Page) =>
    within(page.view.container).queryByRole('heading', { name: 'This document was deleted elsewhere' }) !== null;
  /** No page is ever offered another id. */
  const noNewId = (page: Page) => within(page.view.container).queryByRole('button', { name: 'Try again' }) === null;

  it('keeps a page typed before anything was sent, and creates it once after a crash', async () => {
    const first = await load('');
    type(first, 'Une page.');
    await settle();
    const [record] = await records();
    expect(record).toMatchObject({ content: 'Une page.', base: null, page: { creation: null } });
    const id = record?.key.replace(/^tab-1 /, '') ?? '';
    await first.crash();
    expect(creationsSent()).toEqual([]);

    const second = await load('');
    expect(textarea(second).value).toBe('Une page.');
    await elapse(1000);
    expect(pages()).toEqual(['Une page.']);
    expect(creationsSent()).toEqual([{ id, content: 'Une page.', draftOnly: true }]);
    expect(await stored()).toEqual([]);
  });

  it('sends the same creation again after its answer was lost, then the text typed since as a draft', async () => {
    loseAnswer = isCreation;
    const first = await load('');
    type(first, 'Une page.');
    await elapse(1000);
    expect(pages()).toEqual(['Une page.']);
    type(first, 'Une page neuve.');
    await settle();
    expect(await records()).toMatchObject([
      { content: 'Une page neuve.', base: null, page: { creation: 'Une page.' } },
    ]);
    await first.crash();

    loseAnswer = () => false;
    const second = await load('');
    expect(textarea(second).value).toBe('Une page neuve.');
    await elapse(1000);
    expect(pages()).toEqual(['Une page neuve.']);
    expect(created()).toHaveLength(1);
    expect(new Set(creationsSent().map(({ content }) => content))).toEqual(new Set(['Une page.']));
    expect(oneBodyPerId()).toBe(true);
    expect(await stored()).toEqual([]);
  });

  it('saves the text typed after the creation was answered, once, at the document’s address', async () => {
    lose = isDraftSave;
    const first = await load('');
    type(first, 'Une page.');
    await elapse(1000);
    type(first, 'Une page neuve.');
    await elapse(1000);
    const id = created()[0]?.id ?? '';
    expect(pages()).toEqual(['Une page.']);
    expect(await records()).toEqual([
      { key: `tab-1 ${id}`, content: 'Une page neuve.', base: { content: 'Une page.', draftVersion: 1 } },
    ]);
    await first.crash();

    lose = () => false;
    const second = await load(`#/documents/${id}`);
    expect(textarea(second).value).toBe('Une page neuve.');
    await elapse(1000);
    expect(pages()).toEqual(['Une page neuve.']);
    expect(creationsSent()).toHaveLength(1);
    expect(await stored()).toEqual([]);
  });

  it('brings the page back on the blank page while the server is unreachable, editable, and creates it once', async () => {
    lose = () => true;
    const first = await load('');
    type(first, 'Hors ligne.');
    await elapse(1000);
    await first.crash();

    const second = await load('');
    expect(textarea(second).value).toBe('Hors ligne.');
    expect(textarea(second).readOnly).toBe(false);
    type(second, 'Hors ligne, encore.');
    await elapse(1000);
    // The gone tab's entry went once this tab's write of its text was answered.
    const [kept, ...others] = await records();
    expect(others).toEqual([]);
    expect(kept?.key).toMatch(/^tab-2 /);
    expect(kept).toMatchObject({ content: 'Hors ligne, encore.', page: { creation: 'Hors ligne.' } });
    expect(unload()).toBe(true);

    lose = () => false;
    await elapse(30_000);
    expect(pages()).toEqual(['Hors ligne, encore.']);
    expect(new Set(creationsSent().map(({ content }) => content))).toEqual(new Set(['Hors ligne.']));
    expect(oneBodyPerId()).toBe(true);
    expect(textarea(second).value).toBe('Hors ligne, encore.');
    expect(await stored()).toEqual([]);
    expect(unload()).toBe(false);
  });

  it('shows a restored page on “+ New document” when the app opens on another document', async () => {
    lose = () => true;
    const first = await load('');
    type(first, 'Une page.');
    await elapse(1000);
    await first.crash();

    lose = isCreation;
    const second = await load();
    expect(textarea(second).value).toBe(original);
    fireEvent.click(within(second.view.container).getByRole('button', { name: '+ New document' }));
    await elapse();
    expect(textarea(second).value).toBe('Une page.');
  });

  it('shows the recovery of a page whose document was deleted elsewhere (410), again after a reload', async () => {
    loseAnswer = isCreation;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const first = await load('');
    fireEvent.change(titleField(first) as HTMLInputElement, { target: { value: 'Le phare' } });
    type(first, 'Une page.');
    await elapse(1000);
    const id = created()[0]?.id ?? '';
    db.delete(id);
    loseAnswer = () => false;
    await elapse(2000);
    expect(recovering(first)).toBe(true);
    expect(listed(first)).toEqual([['Your text', 'Une page.']]);
    await first.crash();

    const second = await load('');
    await elapse(1000);
    expect(recovering(second)).toBe(true);
    expect(listed(second)).toEqual([['Your text', 'Une page.']]);
    expect(noNewId(second)).toBe(true);
    expect(accepted.map((input) => input.id)).toEqual([id]);
    expect(creationsSent().every((body) => body.id === id && body.content === 'Une page.')).toBe(true);
    expect(await stored()).toEqual([[`tab-2 ${id}`, 'Une page.']]);

    // A new document made from it is the writer's own act, with the title typed on the page.
    fireEvent.click(within(second.view.container).getByRole('button', { name: 'Save as a new document' }));
    await elapse();
    const made = created().find((document) => document.id !== id);
    expect(made?.draft?.content ?? made?.content).toBe('Une page.');
    expect(made?.title).toBe('Le phare');

    // Discarding the page removes it from the buffer: nothing brings it back.
    fireEvent.click(within(second.view.container).getByRole('button', { name: /Lettres/ }));
    await elapse();
    fireEvent.click(within(second.view.container).getByRole('button', { name: '+ New document' }));
    await elapse();
    fireEvent.click(within(second.view.container).getByRole('button', { name: 'Discard these copies' }));
    await settle();
    expect(await stored()).toEqual([]);
    await second.crash();
    const third = await load('');
    await elapse(1000);
    expect(textarea(third).value).toBe('');
    expect(listed(third)).toEqual([]);
  });

  it('joins the document its id holds when its creation is refused for another text, and offers no new id', async () => {
    const taken = '11111111-1111-4111-8111-111111111111';
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(taken);
    creations.set(taken, JSON.stringify([null, 'Un autre texte.', true]));
    db.set(taken, {
      id: taken,
      title: null,
      revision: 0,
      content: '',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      draft: { content: 'Un autre texte.', draftVersion: 1, baseRevision: null },
    });
    const first = await load('');
    type(first, 'Une page.');
    await elapse(1000);
    expect(noNewId(first)).toBe(true);
    const state = entryOf(first.queryClient, taken)?.autosave.getSnapshot();
    expect(state?.status).toBe('conflict');
    expect(state?.content).toBe('Une page.');
    expect(window.location.hash).toBe(`#/documents/${taken}`);
    expect(pages()).toEqual(['Un autre texte.']);
  });

  it('shows the recovery when its creation is refused for another text and its document cannot be found', async () => {
    intercept = (call) =>
      isCreation(call)
        ? error(422, 'Already created with another body')
        : call.method === 'GET' && call.path.startsWith('/documents/')
          ? notFound()
          : undefined;
    const first = await load('');
    type(first, 'Une page.');
    await elapse(1000);
    expect(recovering(first)).toBe(true);
    expect(listed(first)).toEqual([['Your text', 'Une page.']]);
    expect(noNewId(first)).toBe(true);
    intercept = () => undefined;
    await elapse(60_000);
    expect(accepted).toEqual([]);
  });

  it.each([400, 413])('keeps the id after a %i on creation, and creates the changed text under it', async (status) => {
    intercept = (call) => (isCreation(call) ? error(status, 'Refused') : undefined);
    const first = await load('');
    type(first, 'Une page refusée.');
    await elapse(1000);
    const [refused] = creationsSent();
    expect(within(first.view.container).getByRole('alert').textContent).toContain('The server refused this text');
    expect(await records()).toMatchObject([{ content: 'Une page refusée.', page: { creation: null } }]);
    // The refused text is never sent again.
    await elapse(60_000);
    expect(creationsSent()).toHaveLength(1);

    intercept = () => undefined;
    type(first, 'Une page acceptée.');
    await elapse(1000);
    expect(accepted).toEqual([{ id: refused?.id, content: 'Une page acceptée.', draftOnly: true }]);
    expect(pages()).toEqual(['Une page acceptée.']);
    expect(await stored()).toEqual([]);
  });

  it('restores the pages of two tabs as two documents, one of them on the blank page', async () => {
    lose = () => true;
    const one = await load('');
    const two = await load('');
    type(one, 'La page du premier onglet.');
    await settle();
    type(two, 'La page du second onglet.');
    await elapse(1000);
    await one.crash();
    await two.crash();

    const three = await load('');
    expect(['La page du premier onglet.', 'La page du second onglet.']).toContain(textarea(three).value);
    lose = () => false;
    await elapse(30_000);
    expect(pages()).toEqual(['La page du premier onglet.', 'La page du second onglet.']);
    expect(oneBodyPerId()).toBe(true);
    expect(await stored()).toEqual([]);
  });

  it('never adopts a page another living tab restored, and creates it once after both are gone', async () => {
    lose = () => true;
    const first = await load('');
    type(first, 'Une page.');
    await elapse(1000);
    await first.crash();

    const second = await load('');
    expect(textarea(second).value).toBe('Une page.');
    const third = await load('');
    await elapse(1000);
    expect(textarea(third).value).toBe('');
    expect((await stored()).map(([key, text]) => [key.split(' ')[0], text])).toEqual([['tab-2', 'Une page.']]);
    await second.crash();
    await third.crash();

    lose = () => false;
    const fourth = await load('');
    expect(textarea(fourth).value).toBe('Une page.');
    await elapse(1000);
    expect(pages()).toEqual(['Une page.']);
    expect(oneBodyPerId()).toBe(true);
    expect(await stored()).toEqual([]);
  });

  it('brings back the title typed on the page, and saves it once the document exists', async () => {
    lose = () => true;
    const first = await load('');
    fireEvent.change(titleField(first) as HTMLInputElement, { target: { value: 'Le phare' } });
    type(first, 'Une page.');
    await elapse(1000);
    expect(await records()).toMatchObject([{ page: { creation: 'Une page.', title: 'Le phare' } }]);
    await first.crash();

    lose = () => false;
    const second = await load('');
    expect(titleField(second)?.value).toBe('Le phare');
    await elapse(1000);
    await elapse(1000);
    expect(created().map(({ title, draft }) => [title, draft?.content])).toEqual([['Le phare', 'Une page.']]);
  });

  it('forgets a page erased before anything was sent', async () => {
    const first = await load('');
    type(first, 'Une page.');
    await settle();
    type(first, '');
    await settle();
    expect(await stored()).toEqual([]);
  });

  describe('a crash around the creation request, with the writes not committed yet dropped', () => {
    it('before it: nothing is sent before the creation’s text is kept, and the last text kept comes back', async () => {
      const first = await load('');
      type(first, 'Une page');
      await settle();
      first.buffer?.pause();
      type(first, 'Une page neuve.');
      await elapse(1000);
      expect(creationsSent()).toEqual([]);
      await first.crash();

      const second = await load('');
      expect(textarea(second).value).toBe('Une page');
      await elapse(1000);
      expect(pages()).toEqual(['Une page']);
      expect(await stored()).toEqual([]);
    });

    it('during it: the creation that reached the server is sent again as it was', async () => {
      hold = isCreation;
      const first = await load('');
      type(first, 'Une page.');
      await elapse(1000);
      expect(held).toHaveLength(1);
      first.buffer?.pause();
      type(first, 'Une page neuve.');
      await settle();
      await first.crash();
      // The request had left: the server takes it after the page is gone.
      await releaseHeld();
      expect(pages()).toEqual(['Une page.']);

      const second = await load('');
      expect(textarea(second).value).toBe('Une page.');
      await elapse(1000);
      expect(pages()).toEqual(['Une page.']);
      expect(oneBodyPerId()).toBe(true);
      expect(await stored()).toEqual([]);
    });

    it('after it: the text typed since comes back, and is saved on the document the creation made', async () => {
      hold = isCreation;
      const first = await load('');
      type(first, 'Une page.');
      await elapse(1000);
      type(first, 'Une page neuve.');
      await settle();
      first.buffer?.pause();
      lose = isDraftSave;
      await releaseHeld();
      await elapse(1000);
      expect(pages()).toEqual(['Une page.']);
      await first.crash();

      lose = () => false;
      const second = await load('');
      expect(textarea(second).value).toBe('Une page neuve.');
      await elapse(1000);
      expect(pages()).toEqual(['Une page neuve.']);
      expect(created()).toHaveLength(1);
      expect(oneBodyPerId()).toBe(true);
      expect(await stored()).toEqual([]);
    });
  });

  it('says so when the buffer cannot keep a page, and typing and the creation go on', async () => {
    const failing = crashable();
    failing.faults.put = 'quota';
    const page = await load('', { buffer: failing });
    type(page, 'Une page.');
    await elapse(1000);
    expect(notice(page)).not.toBeNull();
    expect(textarea(page).value).toBe('Une page.');
    type(page, 'Une page neuve.');
    await elapse(1000);
    expect(pages()).toEqual(['Une page neuve.']);
  });

  it('reads a buffer written by the current version as before', async () => {
    // Records as the version before pages wrote them: no `page`. One with no base and no page was never written, and
    // is left alone.
    await raw(async (buffer) => {
      await buffer.put('tab-0 doc-1', { content: 'Il veillait, seul.', base: { content: original, draftVersion: 1 } });
      await buffer.put('tab-0 page-0', { content: 'Sans page.', base: null });
    });
    const page = await load();
    await elapse(1000);
    expect(textarea(page).value).toBe('Il veillait, seul.');
    expect(serverDraft()).toBe('Il veillait, seul.');
    expect(creationsSent()).toEqual([]);
    expect(await stored()).toEqual([['tab-0 page-0', 'Sans page.']]);
  });

  describe('the identity of a page', () => {
    const conflictOf = (page: Page, id: string) => entryOf(page.queryClient, id)?.autosave.getSnapshot();
    /** A page two gone tabs left, whose document was created with `Un.` then deleted elsewhere: its id is refused. */
    const refusedPage = async () => {
      const id = '22222222-2222-4222-8222-222222222222';
      creations.set(id, JSON.stringify([null, 'Un.', true]));
      await raw(async (buffer) => {
        await buffer.put(`tab-A ${id}`, { content: 'Un.', base: null, page: { creation: 'Un.' } });
        await buffer.put(`tab-B ${id}`, { content: 'Un, deux.', base: null, page: { creation: 'Un.' } });
      });
      return id;
    };
    /** Every text the page can still be found by: on screen, in a document's machine, or on the server. */
    const found = (page: Page) => [
      textOf(page)?.value,
      ...listed(page).map(([, text]) => text),
      ...created().flatMap((document) => {
        const entry = entryOf(page.queryClient, document.id);
        return [
          document.draft?.content,
          entry?.autosave.getSnapshot().content,
          ...(entry?.held ?? []).map((t) => t.content),
        ];
      }),
    ];

    it('joins the document a creation got to after a failed write, and offers no second one', async () => {
      const buffer = crashable();
      const first = await load('', { buffer });
      type(first, 'A');
      await settle();
      buffer.faults.put = 'quota';
      loseAnswer = isCreation;
      type(first, 'A, puis B.');
      await elapse(1000);
      expect(pages()).toEqual(['A, puis B.']);
      // The only record left says that nothing was sent.
      expect(await records()).toMatchObject([{ content: 'A', page: { creation: null } }]);
      await first.crash();

      loseAnswer = () => false;
      const second = await load('');
      await elapse(1000);
      expect(noNewId(second)).toBe(true);
      expect(created()).toHaveLength(1);
      const state = conflictOf(second, created()[0]?.id ?? '');
      expect(state?.status).toBe('conflict');
      expect(state?.content).toBe('A');
      expect(state?.status === 'conflict' && state.server.content).toBe('A, puis B.');
    });

    it('joins the document the owner created when a tab without Web Locks adopted its unsent page', async () => {
      const owner = await load('', { locks: false });
      type(owner, 'A');
      await settle();
      const id = (await records())[0]?.key.split(' ')[1] ?? '';
      // The adopter's creation of A gets through only once the owner created the page with its later text.
      lose = (call) => isCreation(call) && (call.body as CreateDraftDocumentInput).content === 'A';
      const adopter = await load('', { locks: false });
      expect(textarea(adopter).value).toBe('A');
      type(owner, 'A, puis B.');
      await elapse(1000);
      expect(db.get(id)?.draft?.content).toBe('A, puis B.');

      lose = () => false;
      await elapse(5000);
      expect(noNewId(adopter) && noNewId(owner)).toBe(true);
      expect(created()).toHaveLength(1);
      expect(conflictOf(adopter, id)?.status).toBe('conflict');
      expect(db.get(id)?.draft?.content).toBe('A, puis B.');
    });

    it('shows the recovery in both tabs that restored the same page deleted elsewhere, and creates nothing', async () => {
      const id = await refusedPage();
      const one = await load('', { locks: false });
      const two = await load('', { locks: false });
      await elapse(1000);
      expect(recovering(one)).toBe(true);
      expect(recovering(two)).toBe(true);
      expect(found(one)).toEqual(expect.arrayContaining(['Un.', 'Un, deux.']));
      expect(found(two)).toEqual(expect.arrayContaining(['Un.', 'Un, deux.']));
      expect(noNewId(one) && noNewId(two)).toBe(true);
      expect(accepted).toEqual([]);
      expect(creationsSent().every((body) => body.id === id)).toBe(true);
    });

    it('lists a page found deleted in the background on the blank page, and opens its recovery', async () => {
      // The second page, left by a tab still open meanwhile: its creation got there, then its document was deleted
      // elsewhere.
      const second = '44444444-4444-4444-8444-444444444444';
      creations.set(second, JSON.stringify([null, 'Seconde page.', true]));
      await raw((buffer) =>
        buffer.put(`tab-A ${second}`, { content: 'Seconde page.', base: null, page: { creation: 'Seconde page.' } }),
      );
      heldLocks.set('reviewr-tab tab-A', 99);
      // The first page, written later: its creations do not get through.
      lose = isCreation;
      const two = await load('');
      type(two, 'Première page.');
      await elapse(1000);
      await two.crash();
      heldLocks.delete('reviewr-tab tab-A');

      lose = (call) => isCreation(call) && (call.body as CreateDraftDocumentInput).content === 'Première page.';
      const three = await load('');
      await elapse(5000);
      expect(textarea(three).value).toBe('Première page.');
      expect(listed(three)).toEqual([['A page not saved yet', 'Seconde page.']]);

      fireEvent.click(within(three.view.container).getByRole('button', { name: 'Open this page' }));
      await elapse();
      expect(recovering(three)).toBe(true);
      expect(listed(three)).toEqual([['Your text', 'Seconde page.']]);
      expect(accepted).toEqual([]);

      fireEvent.click(within(three.view.container).getByRole('button', { name: '+ New document' }));
      await elapse();
      expect(recovering(three)).toBe(true);
    });

    it('removes every record of a discarded page, this tab’s own included, so that no reload brings it back', async () => {
      // A page two gone tabs left, with two texts: the newer one is restored, the older one held as a copy.
      const id = '55555555-5555-4555-8555-555555555555';
      await raw(async (buffer) => {
        await buffer.put(`tab-A ${id}`, { content: 'Une page.', base: null, page: { creation: null } });
        await buffer.put(`tab-B ${id}`, { content: 'Une page, plus longue.', base: null, page: { creation: null } });
      });
      lose = isCreation;
      claimsWait = true;
      const page = await load('');
      type(page, 'Une page neuve.');
      await grantClaims();
      await elapse(1000);
      // Written in the same millisecond, either text can be the newer one, and the other the copy.
      expect(listed(page)).toHaveLength(1);
      expect(['Une page.', 'Une page, plus longue.']).toContain(listed(page)[0]?.[1]);
      // This tab wrote the page under its own key; the copy of another text stays under its gone tab's key.
      const keys = (await stored()).filter(([key]) => key.endsWith(id)).map(([key]) => key.split(' ')[0]);
      expect(keys).toHaveLength(2);
      expect(keys).toContain('tab-1');

      vi.spyOn(window, 'confirm').mockReturnValue(true);
      fireEvent.click(within(page.view.container).getByRole('button', { name: 'Discard this page' }));
      await settle();
      expect((await stored()).map(([, text]) => text)).toEqual(['Une page neuve.']);
      await page.crash();

      const again = await load('');
      await elapse(1000);
      expect(textarea(again).value).toBe('Une page neuve.');
      expect(listed(again)).toEqual([]);
    });

    it('lists a page restored after the writer typed on the blank page, and discards it only when asked', async () => {
      lose = isCreation;
      const one = await load('');
      type(one, 'Une page restaurée.');
      await elapse(1000);
      await one.crash();

      claimsWait = true;
      const two = await load('');
      type(two, 'Une page neuve.');
      await grantClaims();
      await elapse();
      expect(textarea(two).value).toBe('Une page neuve.');
      expect(listed(two)).toEqual([['A page not saved yet', 'Une page restaurée.']]);

      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      fireEvent.click(within(two.view.container).getByRole('button', { name: 'Discard this page' }));
      expect(listed(two)).toHaveLength(1);
      confirm.mockReturnValue(true);
      fireEvent.click(within(two.view.container).getByRole('button', { name: 'Discard this page' }));
      await settle();
      expect(listed(two)).toEqual([]);
      expect((await stored()).map(([, text]) => text)).toEqual(['Une page neuve.']);
    });

    it('makes one document when two tabs without Web Locks restore the same page at once', async () => {
      lose = () => true;
      const first = await load('', { locks: false });
      type(first, 'Une page.');
      await elapse(1000);
      await first.crash();

      const two = await load('', { locks: false });
      const three = await load('', { locks: false });
      expect(textarea(two).value).toBe('Une page.');
      expect(textarea(three).value).toBe('Une page.');
      lose = () => false;
      await elapse(30_000);
      expect(pages()).toEqual(['Une page.']);
      expect(oneBodyPerId()).toBe(true);
    });

    it('shows a conflict, never an overwrite, when page records mix with an ordinary one on a moved draft', async () => {
      const id = '33333333-3333-4333-8333-333333333333';
      creations.set(id, JSON.stringify([null, 'Un.', true]));
      db.set(id, {
        id,
        title: null,
        revision: 0,
        content: '',
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
        draft: { content: 'Un, autre.', draftVersion: 2, baseRevision: null },
      });
      await raw(async (buffer) => {
        await buffer.put(`tab-A ${id}`, { content: 'Un, deux.', base: null, page: { creation: 'Un.' } });
        await buffer.put(`tab-B ${id}`, { content: 'Un, trois.', base: { content: 'Un.', draftVersion: 1 } });
      });
      const page = await load(`#/documents/${id}`);
      await elapse(1000);
      expect(db.get(id)?.draft?.content).toBe('Un, autre.');
      expect(conflictOf(page, id)?.status).toBe('conflict');
      expect(found(page)).toEqual(expect.arrayContaining(['Un, deux.', 'Un, trois.']));
      expect(created()).toHaveLength(1);
      expect(creationsSent()).toEqual([]);
    });
  });

  describe('the identity of a page, on random runs', () => {
    /** A small seeded generator (mulberry32), so a failing run can be replayed. */
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    it.each(Array.from({ length: 16 }, (_, i) => i + 1))(
      'accepts one creation per page at most, under its own id, loses no text and keeps every page reachable, run %i',
      async (seed) => {
        const next = random(seed);
        const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
        const locks = seed % 2 === 0;
        interface Tab {
          page: Page;
          buffer: CrashableBuffer;
          /** The last text of each page this tab's buffer kept, by marker. */
          kept: Map<string, string>;
        }
        const open: Tab[] = [];
        /**
         * The texts a buffer kept and nothing deliberately superseded yet: each must end confirmed by the server, on
         * screen or in the buffer. A tab supersedes its own previous text of a page by keeping a newer one, and a text
         * it edits by keeping the edit; a write that fails supersedes nothing. Edits only append here, so a text whose
         * later edit the server confirmed is superseded too.
         */
        const owed = new Set<string>();
        /** The pages any of whose texts a buffer kept. */
        const keptPages = new Set<string>();
        /** Pages whose document another device deleted: their confirmed texts may be gone with it. */
        const deleted = new Set<string>();
        let started = 0;
        let words = 0;
        const markerOf = (text: string) => /^P\d+:/.exec(text)?.[0];
        for (let step = 0; step < 22; step++) {
          const roll = next();
          if (open.length === 0 || (roll < 0.12 && open.length < 3)) {
            const buffer = crashable();
            claimsWait = next() < 0.3;
            const page = await load('', { buffer, locks });
            await grantClaims();
            await elapse(100);
            open.push({ page, buffer, kept: new Map() });
          } else if (roll < 0.5) {
            const tab = pick(open);
            const before = textOf(tab.page)?.value;
            if (before === undefined) continue;
            const marker = before === '' ? `P${++started}:` : markerOf(before);
            if (marker === undefined) continue;
            const text = before === '' ? `${marker} mot${++words}` : `${before} mot${++words}`;
            type(tab.page, text);
            if (tab.buffer.faults.put === undefined) {
              owed.delete(before);
              const previous = tab.kept.get(marker);
              if (previous !== undefined) owed.delete(previous);
              owed.add(text);
              tab.kept.set(marker, text);
              keptPages.add(marker);
            }
            await settle();
            await elapse(pick([0, 300, 1200]));
          } else if (roll < 0.66) {
            const network = pick(['up', 'down', 'lost answers', 'drafts lost', 'creations refused'] as const);
            lose = network === 'down' ? () => true : network === 'drafts lost' ? isDraftSave : () => false;
            loseAnswer = network === 'lost answers' ? isCreation : () => false;
            intercept =
              network === 'creations refused'
                ? (call) => (isCreation(call) ? error(413, 'Too large') : undefined)
                : () => undefined;
            await elapse(pick([0, 1000]));
          } else if (roll < 0.73) {
            // The tab's buffer stops keeping anything, after it kept earlier texts.
            pick(open).buffer.faults.put = 'quota';
          } else if (roll < 0.79) {
            const tab = pick(open);
            const [button] = within(tab.page.view.container).queryAllByRole('button', { name: 'Open this page' });
            if (button === undefined) continue;
            fireEvent.click(button);
            await elapse(100);
          } else if (roll < 0.86) {
            // Another device deletes a document made from a page.
            const document = pick([undefined, ...created()]);
            if (document === undefined) continue;
            const marker = markerOf(document.draft?.content ?? '');
            if (marker !== undefined) deleted.add(marker);
            db.delete(document.id);
          } else {
            const tab = pick(open);
            open.splice(open.indexOf(tab), 1);
            await tab.page.crash();
          }
        }
        for (const tab of open) await tab.page.crash();

        lose = () => false;
        loseAnswer = () => false;
        intercept = () => undefined;
        claimsWait = false;
        const last = await load('', { locks });
        for (let round = 0; round < 4; round++) await elapse(10_000);

        const onScreen = [
          textOf(last)?.value,
          ...listed(last).map(([, text]) => text),
          ...[...db.keys()].flatMap((id) => {
            const entry = entryOf(last.queryClient, id);
            const state = entry?.autosave.getSnapshot();
            return [
              state?.content,
              state?.status === 'conflict' ? state.server.content : undefined,
              ...(entry?.held ?? []).map((text) => text.content),
            ];
          }),
        ].filter((text): text is string => text !== undefined);
        const inBuffer = (await stored()).map(([, text]) => text);
        expect(noNewId(last)).toBe(true);
        for (let page = 1; page <= started; page++) {
          const marker = `P${page}:`;
          const ids = new Set(
            accepted.filter((input) => input.content.startsWith(`${marker} `)).map((input) => input.id),
          );
          expect(ids.size, `${marker} was created once at most, under one id`).toBeLessThanOrEqual(1);
          const live = created().some((document) => document.draft?.content.startsWith(`${marker} `));
          if (keptPages.has(marker) && !live && !deleted.has(marker)) {
            expect(
              onScreen.some((text) => text.startsWith(`${marker} `)),
              `${marker} is reachable`,
            ).toBe(true);
          }
        }
        const confirmed = (text: string) =>
          [...everSaved].some((saved) => saved === text || saved.startsWith(`${text} `));
        for (const text of owed) {
          expect(confirmed(text) || onScreen.includes(text) || inBuffer.includes(text), text).toBe(true);
        }
      },
    );
  });
});
