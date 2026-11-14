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
 * Web Locks (very old browsers), every other tab counts as gone: a living tab's text may then be sent by two tabs, which
 * at worst shows one more conflict.
 *
 * Pages not created on the server yet (`base: null`) are not written: restoring one must send its creation again
 * unchanged, which needs more than the buffer keeps today.
 */

/** A text a gone tab left for a document, as the registry restores it. */
export interface LeftText {
  /** Its key in the buffer: deleted once the text is the local text, saved, or discarded. */
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

type Op = { kind: 'put'; content: string; base: Draft } | { kind: 'delete'; ifContent?: string };

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
}

interface DeviceBuffer extends DeviceBufferOptions {
  mirrors: Map<string, Mirror>;
  /** Gone tabs whose lock this tab took: their entries are this tab's to restore. */
  claimed: Set<string>;
  /** Keys already handed to the registry, so that opening a document again does not restore them twice. */
  adopted: Set<string>;
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
    adopted: new Set(),
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
    const condition = op.kind === 'delete' && op.ifContent !== undefined && !mirror.stale;
    const result =
      op.kind === 'put'
        ? await buffer.put(mirror.key, { content: op.content, base: op.base })
        : await buffer.delete(mirror.key, condition ? { ifContent: op.ifContent ?? '' } : undefined);
    if (op.kind === 'put') mirror.stale = !result.ok;
    if (!result.ok) report(device, result.reason);
  }
  mirror.running = false;
};

const enqueue = (device: DeviceBuffer, documentId: string, op: Op) => {
  if (device.buffer === null) return;
  let mirror = device.mirrors.get(documentId);
  if (mirror === undefined) {
    mirror = { key: keyOf(device.tabId, documentId), queue: [], running: false, dirty: false, stale: false };
    device.mirrors.set(documentId, mirror);
  }
  if (sameOp(mirror.last, op)) return;
  if (op.kind === 'delete' && op.ifContent !== undefined && !mirror.dirty) return;
  mirror.last = op;
  mirror.dirty = op.kind === 'put';
  // Only the newest text matters: a put not started yet is replaced by the next one.
  const tail = mirror.queue.at(-1);
  if (op.kind === 'put' && tail?.kind === 'put') mirror.queue[mirror.queue.length - 1] = op;
  else mirror.queue.push(op);
  void drain(device, mirror);
};

/**
 * Writes a document's machine state: its text and base while the server has not confirmed it, a delete of that very
 * text once it is `saved` (a text written after it stays).
 */
export const mirrorState = (queryClient: QueryClient, documentId: string, state: AutosaveState) => {
  const device = deviceOf(queryClient);
  if (state.status === 'saved') enqueue(device, documentId, { kind: 'delete', ifContent: state.content });
  else enqueue(device, documentId, { kind: 'put', content: state.content, base: state.base });
};

/** Writes a restored text under this tab's key, whatever its machine says, before the gone tab's entry is deleted. */
export const keepRestored = (queryClient: QueryClient, documentId: string, content: string, base: Draft) =>
  enqueue(deviceOf(queryClient), documentId, { kind: 'put', content, base });

/** Deletes the entry `key` if it still holds `content`: a gone tab's text that is now kept elsewhere or saved. */
export const dropLeftText = (queryClient: QueryClient, key: string, content: string) => {
  const device = deviceOf(queryClient);
  if (device.buffer === null) return;
  void device.buffer.delete(key, { ifContent: content }).then((result) => {
    if (!result.ok) report(device, result.reason);
  });
};

/** The writer discarded a document's texts: this tab's entry and the gone tabs' `keys` go. */
export const forgetDocument = (queryClient: QueryClient, documentId: string, keys: readonly string[]) => {
  const device = deviceOf(queryClient);
  const mirror = device.mirrors.get(documentId);
  if (mirror !== undefined) mirror.queue.length = 0;
  enqueue(device, documentId, { kind: 'delete' });
  for (const key of keys) {
    void device.buffer?.delete(key).then((result) => {
      if (!result.ok) report(device, result.reason);
    });
  }
};

/** Takes the lock of a tab, if that tab is gone; once taken, it is kept. */
const claim = (device: DeviceBuffer, tabId: string): Promise<boolean> => {
  const { locks } = device;
  if (device.claimed.has(tabId) || locks === null) return Promise.resolve(true);
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

/**
 * The texts gone tabs left, by document (all of them, or only `documentId`'s), the most recent first. Each is
 * handed out once.
 */
export const adoptLeftTexts = (queryClient: QueryClient, documentId?: string): Promise<Map<string, LeftText[]>> => {
  const device = deviceOf(queryClient);
  const { buffer } = device;
  const run = async (): Promise<Map<string, LeftText[]>> => {
    const left = new Map<string, LeftText[]>();
    if (buffer === null) return left;
    await device.ready;
    const listed = await buffer.list();
    if (!listed.ok) report(device, listed.reason);
    const candidates = listed.entries.filter((entry: BufferEntry) => {
      const owner = parseKey(entry.key);
      return (
        owner !== undefined &&
        owner.tabId !== device.tabId &&
        (documentId === undefined || owner.documentId === documentId) &&
        entry.base !== null &&
        !device.adopted.has(entry.key)
      );
    });
    for (const { key, content, base } of candidates) {
      const owner = parseKey(key);
      if (owner === undefined || base === null || !(await claim(device, owner.tabId))) continue;
      device.adopted.add(key);
      const texts = left.get(owner.documentId) ?? [];
      texts.push({ key, content, base });
      left.set(owner.documentId, texts);
    }
    return left;
  };
  const adoption = device.adoption.then(run, run);
  device.adoption = adoption;
  return adoption;
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
