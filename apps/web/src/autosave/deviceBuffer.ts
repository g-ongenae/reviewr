import type { QueryClient } from '@tanstack/react-query';
import type { AutosaveState, Draft } from './autosave';
import { openLocalBuffer, type BufferEntry, type BufferFailureReason, type LocalBuffer } from './localBuffer';

/**
 * The copy of the text being written that this device keeps, in the local buffer, until the server confirmed it.
 *
 * It mirrors the autosave machines, it never decides for them: each document's machine state is written as it
 * changes (its local text and the base it was written from), and removed once the machine says `saved`, only if the
 * buffer still holds that confirmed text. On start and when a document is opened, the texts that closed or crashed tabs
 * left behind are handed to the registry, which rebuilds machines from them (see `restore` in `useAutosave`).
 *
 * **One entry per tab.** Each page load is a tab with its own id, and writes under `"<tab id> <document id>"`, so two
 * tabs on one document never overwrite each other's text. A tab holds a Web Lock named after its id while it lives:
 * the entries of a tab whose lock is free belong to a tab that is gone, and the first tab to take that lock adopts
 * them (and keeps the lock, so no other tab adopts them too). The entries of a living tab are never touched. Without
 * Web Locks (very old browsers), every other tab counts as gone: adoption is then not exclusive, and only the first
 * rule below keeps the texts safe; a living tab's text may be sent by two tabs, which at worst shows one more conflict.
 *
 * **The invariant of adoption.** Two rules, and the code follows them in one place each:
 *
 * 1. A text leaves the buffer only when the server confirmed that text, the writer discarded it, or a write of that
 *    same text elsewhere in the buffer was answered ok. Never because a write was queued, nor because a text in memory
 *    matches it. (`dropLeftText` is the only delete of another tab's entry; the registry calls it on exactly these
 *    three events, see `letGo` in `useAutosave`.)
 * 2. Every decision about another tab's entries is taken on records read while holding that tab's lock. A first list
 *    only says which tabs left something; their entries are read again once their locks are held (`adoptLeftTexts`),
 *    since a tab can write or delete until it is gone.
 *
 * **What a crash can lose.** A text is kept once the transaction of its put committed. Until then it is only in
 * memory: the newest text waits behind the put in progress and the other calls queued on the buffer, so this window is
 * not bounded by the autosave's debounce, only by how fast IndexedDB answers (and its timeouts). Puts not started yet
 * are coalesced, so after a crash the text that comes back is the last one whose put committed, never an older one.
 *
 * Pages not created on the server yet (`base: null`) are not written: restoring one must send its creation again
 * unchanged, which needs more than the buffer keeps today.
 */

/** A text a gone tab left for a document, read under that tab's lock. */
export interface LeftText {
  /** Its key in the buffer: deleted only as the invariant of adoption says. */
  key: string;
  content: string;
  base: Draft;
}

/** The Web Locks API, as far as it is used here. */
export type Locks = Pick<LockManager, 'request'>;

export interface DeviceBufferOptions {
  /** `null` when the browser has no IndexedDB: nothing is kept, and the writer is told. */
  buffer: LocalBuffer | null;
  /** `null` without Web Locks. */
  locks: Locks | null;
  tabId: string;
}

/** A write of this tab's entry; a `pinned` put is never coalesced away (a restored text must be written once). */
type Op = { kind: 'put'; content: string; base: Draft; pinned?: boolean } | { kind: 'delete'; ifContent?: string };

/** What this tab writes for one document: one operation at a time, in order, consecutive puts coalesced. */
interface Mirror {
  key: string;
  queue: Op[];
  running: boolean;
  /** The last operation queued, to skip repeats: a state change that changes neither the text nor the base. */
  last?: Op;
  /** Whether this tab may have an entry for the document: only then is a confirmation worth a delete. */
  dirty: boolean;
  /**
   * A put failed since the last one that landed, so the entry may hold an older text than the one confirmed: the next
   * confirmation deletes it whatever it holds. This tab is the only writer of its key, and its calls run in order, so
   * that delete cannot remove a later text.
   */
  stale: boolean;
  /** The text of the last put answered ok, while the entry holds it. */
  kept?: string;
  /** Told each time a put is answered ok, with its text. */
  onKept?: (content: string) => void;
}

interface DeviceBuffer extends DeviceBufferOptions {
  mirrors: Map<string, Mirror>;
  /** Gone tabs whose lock this tab took (every other tab, without Web Locks): their entries are this tab's to restore. */
  claimed: Set<string>;
  /** Keys the registry took over, so that opening a document again does not restore them twice. */
  handed: Set<string>;
  /** Adoptions run one after the other. */
  adoption: Promise<unknown>;
  /** Settles once this tab holds its own lock: nothing is adopted before, or a tab could adopt its own entries. */
  ready: Promise<void>;
  /** The first failure the buffer answered, which the writer is told about once. */
  failure?: BufferFailureReason;
  listeners: Set<() => void>;
}

const devices = new WeakMap<QueryClient, DeviceBuffer>();

const lockName = (tabId: string) => `reviewr-tab ${tabId}`;

const keyOf = (tabId: string, documentId: string) => `${tabId} ${documentId}`;

/** The tab and the document of a key; `undefined` for a key in another format. */
const parseKey = (key: string): { tabId: string; documentId: string } | undefined => {
  const space = key.indexOf(' ');
  return space <= 0 ? undefined : { tabId: key.slice(0, space), documentId: key.slice(space + 1) };
};

/** Never settles: a lock held with it is held until the page goes away. */
const forever = new Promise<void>(() => {});

const report = (device: DeviceBuffer, reason: BufferFailureReason) => {
  if (device.failure !== undefined) return;
  device.failure = reason;
  for (const listener of [...device.listeners]) listener();
};

/**
 * Sets the device buffer of a query client (the app has one; tests make one per simulated page load). Without a call,
 * the first use opens IndexedDB and the Web Locks of the browser, under a new tab id.
 */
export const configureDeviceBuffer = (queryClient: QueryClient, options: DeviceBufferOptions): DeviceBuffer => {
  const { buffer, locks, tabId } = options;
  const device: DeviceBuffer = {
    ...options,
    mirrors: new Map(),
    claimed: new Set(),
    handed: new Set(),
    adoption: Promise.resolve(),
    ready: Promise.resolve(),
    listeners: new Set(),
  };
  if (buffer === null) {
    device.failure = 'unavailable';
  } else if (locks !== null) {
    device.ready = new Promise<void>((granted) => {
      locks
        .request(lockName(tabId), () => {
          granted();
          return forever;
        })
        // No lock for this tab: its entries are then as safe as without Web Locks.
        .catch(() => granted());
    });
  }
  devices.set(queryClient, device);
  return device;
};

const deviceOf = (queryClient: QueryClient): DeviceBuffer => {
  const device = devices.get(queryClient);
  if (device === undefined) {
    const hasIndexedDB = typeof indexedDB !== 'undefined';
    const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;
    return configureDeviceBuffer(queryClient, {
      buffer: hasIndexedDB ? openLocalBuffer() : null,
      locks: locks ?? null,
      // Any text without a space names a tab: pages served over plain HTTP have no `randomUUID`.
      tabId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    });
  }
  return device;
};

/** Whether this device keeps a buffer at all: if not, nothing is restored, and nothing waits for a restore. */
export const hasDeviceBuffer = (queryClient: QueryClient): boolean => deviceOf(queryClient).buffer !== null;

const sameOp = (a: Op | undefined, b: Op): boolean => {
  if (a === undefined || a.kind !== b.kind) return false;
  if (a.kind === 'put' && b.kind === 'put') return a.content === b.content && a.base === b.base;
  return a.kind === 'delete' && b.kind === 'delete' && a.ifContent === b.ifContent;
};

const drain = async (device: DeviceBuffer, mirror: Mirror) => {
  const { buffer } = device;
  if (mirror.running || buffer === null) return;
  mirror.running = true;
  for (let op = mirror.queue.shift(); op !== undefined; op = mirror.queue.shift()) {
    if (op.kind === 'put') {
      const result = await buffer.put(mirror.key, { content: op.content, base: op.base });
      mirror.stale = !result.ok;
      mirror.kept = result.ok ? op.content : undefined;
      if (result.ok) mirror.onKept?.(op.content);
      else report(device, result.reason);
    } else {
      const condition = op.ifContent !== undefined && !mirror.stale;
      const result = await buffer.delete(mirror.key, condition ? { ifContent: op.ifContent ?? '' } : undefined);
      if (result.ok && (result.deleted || !condition)) mirror.kept = undefined;
      if (!result.ok) report(device, result.reason);
    }
  }
  mirror.running = false;
};

const mirrorOf = (device: DeviceBuffer, documentId: string): Mirror => {
  let mirror = device.mirrors.get(documentId);
  if (mirror === undefined) {
    mirror = { key: keyOf(device.tabId, documentId), queue: [], running: false, dirty: false, stale: false };
    device.mirrors.set(documentId, mirror);
  }
  return mirror;
};

const enqueue = (device: DeviceBuffer, documentId: string, op: Op) => {
  if (device.buffer === null) return;
  const mirror = mirrorOf(device, documentId);
  if (sameOp(mirror.last, op)) return;
  if (op.kind === 'delete' && op.ifContent !== undefined && !mirror.dirty) return;
  mirror.last = op;
  mirror.dirty = op.kind === 'put';
  // Only the newest text matters: a put not started yet is replaced by the next one, unless it is pinned.
  const tail = mirror.queue.at(-1);
  if (op.kind === 'put' && tail?.kind === 'put' && tail.pinned !== true) mirror.queue[mirror.queue.length - 1] = op;
  else mirror.queue.push(op);
  void drain(device, mirror);
};

/**
 * Writes a document's machine state: its text and base while the server has not confirmed it, a delete of that very
 * text once it is `saved` (a text written after it stays). `onKept` hears each put answered ok.
 */
export const mirrorState = (
  queryClient: QueryClient,
  documentId: string,
  state: AutosaveState,
  onKept: (content: string) => void,
) => {
  const device = deviceOf(queryClient);
  if (device.buffer === null) return;
  mirrorOf(device, documentId).onKept = onKept;
  if (state.status === 'saved') enqueue(device, documentId, { kind: 'delete', ifContent: state.content });
  else enqueue(device, documentId, { kind: 'put', content: state.content, base: state.base });
};

/** Writes a restored text under this tab's key, once, whatever is typed after it; `onKept` hears it landed. */
export const keepRestored = (
  queryClient: QueryClient,
  documentId: string,
  content: string,
  base: Draft,
  onKept: (content: string) => void,
) => {
  const device = deviceOf(queryClient);
  if (device.buffer === null) return;
  mirrorOf(device, documentId).onKept = onKept;
  enqueue(device, documentId, { kind: 'put', content, base, pinned: true });
};

/** The text this tab's entry for the document holds, as last answered ok; `undefined` if unknown or none. */
export const keptText = (queryClient: QueryClient, documentId: string): string | undefined =>
  deviceOf(queryClient).mirrors.get(documentId)?.kept;

/**
 * Deletes another tab's entry `key` if it still holds `content`. The only delete of another tab's entry: call it only
 * as the invariant of adoption allows (the server confirmed `content`, the writer discarded it, or a put of `content`
 * elsewhere in the buffer was answered ok).
 */
export const dropLeftText = (queryClient: QueryClient, key: string, content: string) => {
  const device = deviceOf(queryClient);
  if (device.buffer === null) return;
  void device.buffer.delete(key, { ifContent: content }).then((result) => {
    if (!result.ok) report(device, result.reason);
  });
};

/** The writer discarded a document's own text: this tab's entry goes. */
export const forgetDocument = (queryClient: QueryClient, documentId: string) => {
  const device = deviceOf(queryClient);
  const mirror = device.mirrors.get(documentId);
  if (mirror !== undefined) mirror.queue.length = 0;
  enqueue(device, documentId, { kind: 'delete' });
};

/** Takes the lock of a tab, if that tab is gone; once taken, it is kept. Without Web Locks, every tab counts as gone. */
const claim = (device: DeviceBuffer, tabId: string): Promise<boolean> => {
  const { locks } = device;
  if (device.claimed.has(tabId)) return Promise.resolve(true);
  if (locks === null) {
    device.claimed.add(tabId);
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    locks
      .request(lockName(tabId), { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(false);
          return undefined;
        }
        device.claimed.add(tabId);
        resolve(true);
        return forever;
      })
      .catch(() => resolve(false));
  });
};

/** Whether a record is a text another tab left that this adoption may look at. */
const leftBy = (device: DeviceBuffer, entry: BufferEntry, documentId: string | undefined) => {
  const owner = parseKey(entry.key);
  return owner !== undefined &&
    owner.tabId !== device.tabId &&
    (documentId === undefined || owner.documentId === documentId) &&
    entry.base !== null
    ? owner
    : undefined;
};

/**
 * The texts gone tabs left, by document (all of them, or only `documentId`'s), the most recent first, read under
 * their tabs' locks (rule 2). A text stays offered until the registry takes it over (`markHanded`).
 */
export const adoptLeftTexts = (queryClient: QueryClient, documentId?: string): Promise<Map<string, LeftText[]>> => {
  const device = deviceOf(queryClient);
  const { buffer } = device;
  const run = async (): Promise<Map<string, LeftText[]>> => {
    const left = new Map<string, LeftText[]>();
    if (buffer === null) return left;
    await device.ready;
    // Only to find out which tabs left something: nothing below is decided on these records.
    const first = await buffer.list();
    if (!first.ok) {
      report(device, first.reason);
      return left;
    }
    const owners = new Set(first.entries.flatMap((entry) => leftBy(device, entry, documentId)?.tabId ?? []));
    for (const owner of owners) await claim(device, owner);
    // Read again, now that the locks are held: these records can no longer change but through this tab.
    const fresh = await buffer.list();
    if (!fresh.ok) {
      report(device, fresh.reason);
      return left;
    }
    for (const entry of fresh.entries) {
      const owner = leftBy(device, entry, documentId);
      if (owner === undefined || entry.base === null || !device.claimed.has(owner.tabId)) continue;
      if (device.handed.has(entry.key)) continue;
      const texts = left.get(owner.documentId) ?? [];
      texts.push({ key: entry.key, content: entry.content, base: entry.base });
      left.set(owner.documentId, texts);
    }
    return left;
  };
  const adoption = device.adoption.then(run, run);
  device.adoption = adoption;
  return adoption;
};

/** The registry took these texts over: they are not offered again in this tab. */
export const markHanded = (queryClient: QueryClient, keys: readonly string[]) => {
  const { handed } = deviceOf(queryClient);
  for (const key of keys) handed.add(key);
};

/** Why the buffer could not keep the text, the first time it could not; `undefined` while it can. */
export const deviceBufferFailure = (queryClient: QueryClient): BufferFailureReason | undefined =>
  deviceOf(queryClient).failure;

export const subscribeDeviceBufferFailure = (queryClient: QueryClient, listener: () => void): (() => void) => {
  const { listeners } = deviceOf(queryClient);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
