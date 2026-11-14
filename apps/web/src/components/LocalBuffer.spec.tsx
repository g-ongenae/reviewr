import type { CreateDraftDocumentInput, Document, DocumentSummary, SaveDraftInput } from '@reviewr/shared';
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
/** Every text the server ever saved as a draft. */
let everSaved: Set<string>;

/** The API's rules for listing and reading documents, and for saving a draft. */
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
    const existing = db.get(input.id);
    if (existing !== undefined) return reply(201, existing);
    const created: Document = {
      id: input.id,
      title: input.title ?? null,
      revision: 0,
      content: '',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      draft: { content: input.content, draftVersion: 1, baseRevision: null },
    };
    db.set(input.id, created);
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
      const record = { content: value.content, base: value.base };
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
  calls = [];
  lose = () => false;
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
    if (hold(call)) return new Promise<Response>((resolve) => held.push(() => resolve(fakeApi(call))));
    return Promise.resolve(fakeApi(call));
  });
});

afterEach(async () => {
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

  it('writes nothing for a page whose document is not created yet', async () => {
    lose = () => true;
    const page = await load('');
    type(page, 'Une page neuve.');
    await elapse(1000);
    expect(await stored()).toEqual([]);
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
    expect(await stored()).toEqual([]);

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
