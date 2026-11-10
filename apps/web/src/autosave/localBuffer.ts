/**
 * The local buffer: the text being written, kept in IndexedDB until the server confirmed it.
 *
 * It keeps, for each document, the writer's latest text and the **base** it started from (the server draft content and
 * `draftVersion` the edits were made on), so the text can be restored after a crash or a failed request, and compared
 * three-way with the server's draft later. The key is the document id, or a key made by the client for a document that
 * does not exist on the server yet (its `base` is then `null`).
 *
 * Like the autosave core, it is framework-free: no React, no HTTP, and nothing imports it yet.
 *
 * Guarantees:
 *
 * - **Call order.** Every call runs in the order it was made, one after the other: the last `put` for a key wins even
 *   when calls overlap, a `delete` made before a later `put` never removes that later text, and a read sees every
 *   write made before it.
 * - **Conditional delete.** `delete(key, { ifContent })` removes the entry only if it still holds that text, checked
 *   in the same transaction. Delete with the content the server confirmed: text typed while the save was in flight
 *   stays in the buffer.
 * - **Never throws.** Every call resolves, never rejects. When IndexedDB is missing, blocked by another tab, full, or
 *   fails (private mode, old browser, an open that never answers), the result is `{ ok: false, reason }`, which the UI
 *   can show; reads then answer "nothing stored" (`entry: undefined`, `entries: []`). A failed open is tried again on
 *   the next call.
 * - **Durable writes.** A write resolves `ok` once its transaction completed, with `durability: 'strict'` where the
 *   browser supports it (flushed to disk, not only to the OS cache).
 * - **Versioned schema.** The database is upgraded step by step through `localBufferSchema` (one migration per
 *   version). Later versions (the outbox) append a migration; buffered text is kept across upgrades.
 * - **Upgrades are not blocked by this tab.** When another tab opens a newer version, this connection closes itself;
 *   the next call reopens (and fails with `failed` if this tab's code is older than the database).
 *
 * Not done yet:
 *
 * - **Wiring.** Nothing writes to the buffer yet. The editor and the Composer will `put` on every edit, `delete` with
 *   `ifContent` once the autosave core confirmed a save, and `list` on start to restore text left by a crash.
 * - **Outbox.** Pending operations (create, save draft, save version, rename) and their replay on reconnect are a
 *   separate store, added by a later schema version.
 * - **Multi-tab coordination.** Tabs share one database and nothing coordinates them. Two tabs editing the same
 *   document write under the same key, so the buffer holds whichever text was written last: the other tab's unsent
 *   text is then only in that tab's memory (and its own autosave), and is lost from the buffer if that tab crashes.
 *   On the server, the stale `draftVersion` of the second save is still caught as a conflict.
 */

/** The server draft the local edits started from. */
export interface BufferBase {
  content: string;
  draftVersion: number;
}

/** What the buffer stores per key. */
export interface BufferEntry {
  /** The document id, or a client-made key for a document not created on the server yet. */
  key: string;
  /** The writer's latest text. */
  content: string;
  /** The server draft the edits started from; `null` for a document not created on the server yet. */
  base: BufferBase | null;
  /** When the entry was written, in milliseconds since the epoch. */
  updatedAt: number;
}

/**
 * Why a call failed:
 *
 * - `unavailable`: IndexedDB is missing, refused to open (private mode, old browser) or never answered;
 * - `blocked`: another tab holds an older version open and does not close it, so the database cannot be upgraded;
 * - `quota`: the storage is full;
 * - `failed`: anything else (a transaction aborted, a database newer than this code…).
 */
export type BufferFailureReason = 'unavailable' | 'blocked' | 'quota' | 'failed';

export interface BufferFailure {
  ok: false;
  reason: BufferFailureReason;
  error: unknown;
}

export type GetResult = { ok: true; entry: BufferEntry | undefined } | (BufferFailure & { entry: undefined });
export type ListResult = { ok: true; entries: BufferEntry[] } | (BufferFailure & { entries: [] });
export type PutResult = { ok: true } | BufferFailure;
/** `deleted` is `false` when there was nothing to delete or the stored text was not `ifContent`. */
export type DeleteResult = { ok: true; deleted: boolean } | (BufferFailure & { deleted: false });

export interface DeleteCondition {
  /** Delete only if the stored content is exactly this text (the content the server confirmed). */
  ifContent: string;
}

export interface LocalBuffer {
  /** Reads the entry for `key`. */
  get(key: string): Promise<GetResult>;
  /** Stores the latest text for `key` and the base it started from, replacing what was there. */
  put(key: string, value: { content: string; base: BufferBase | null }): Promise<PutResult>;
  /** Removes the entry for `key`, unconditionally or only if it still holds `condition.ifContent`. */
  delete(key: string, condition?: DeleteCondition): Promise<DeleteResult>;
  /** Every entry, the most recently written first. */
  list(): Promise<ListResult>;
  /** Closes the database once the pending calls are done. Calls made after it fail as `unavailable`. */
  close(): Promise<void>;
}

/** One schema step: run when upgrading from version `index` to `index + 1`. */
export type Migration = (db: IDBDatabase, transaction: IDBTransaction) => void;

const DRAFTS = 'drafts';

/** The schema: the database version is its length. Append to it, never edit a step that shipped. */
export const localBufferSchema: readonly Migration[] = [
  // 1: the buffered drafts, keyed by document id or client-made key.
  (db) => {
    db.createObjectStore(DRAFTS, { keyPath: 'key' });
  },
];

export interface LocalBufferOptions {
  /** The IndexedDB factory; `null` when there is none. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory | null;
  /** The database name. Defaults to `reviewr`. */
  name?: string;
  /** Defaults to `localBufferSchema`; tests pass a longer one to simulate an upgrade. */
  schema?: readonly Migration[];
  /** How long to wait for the database to open before giving up as `unavailable`. Defaults to 5 seconds. */
  openTimeoutMs?: number;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

class BufferError extends Error {
  constructor(
    readonly reason: BufferFailureReason,
    readonly error: unknown,
  ) {
    super(`Local buffer ${reason}`);
  }
}

const failure = (error: unknown): BufferFailure => {
  if (error instanceof BufferError) return { ok: false, reason: error.reason, error: error.error };
  const name = (error as { name?: unknown } | null)?.name;
  return { ok: false, reason: name === 'QuotaExceededError' ? 'quota' : 'failed', error };
};

const isBase = (value: unknown): value is BufferBase =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as BufferBase).content === 'string' &&
  typeof (value as BufferBase).draftVersion === 'number';

/** Reads a stored record defensively: whatever holds text is returned, a malformed base becomes `null`. */
const toEntry = (record: unknown): BufferEntry | undefined => {
  if (typeof record !== 'object' || record === null) return undefined;
  const { key, content, base, updatedAt } = record as Record<string, unknown>;
  if (typeof key !== 'string' || typeof content !== 'string') return undefined;
  return {
    key,
    content,
    base: isBase(base) ? { content: base.content, draftVersion: base.draftVersion } : null,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  };
};

/**
 * Runs `body` in a transaction on the drafts store and resolves with what `result` returns once the transaction
 * completed, or rejects with the error that aborted it.
 */
const transact = <T>(db: IDBDatabase, mode: IDBTransactionMode, body: (store: IDBObjectStore) => () => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    try {
      transaction = db.transaction(DRAFTS, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      const tx = transaction;
      const result = body(tx.objectStore(DRAFTS));
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(tx.error ?? new DOMException('The transaction was aborted', 'AbortError'));
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        // Already finished or aborted.
      }
      // Kept as is: a DOMException carries the name (QuotaExceededError) the result is classified by.
      reject(error as Error);
    }
  });

export const openLocalBuffer = (options: LocalBufferOptions = {}): LocalBuffer => {
  const { name = 'reviewr', schema = localBufferSchema, openTimeoutMs = 5000, now = () => Date.now() } = options;
  const factory = options.indexedDB === undefined ? (globalThis.indexedDB ?? null) : options.indexedDB;

  let connection: Promise<IDBDatabase> | undefined;
  let closed = false;
  /** The end of the queue: every call runs after the previous one settled. */
  let tail: Promise<unknown> = Promise.resolve();

  const open = (): Promise<IDBDatabase> => {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (factory === null) {
        reject(new BufferError('unavailable', new Error('IndexedDB is not available')));
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(name, schema.length);
      } catch (error) {
        reject(new BufferError('unavailable', error));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => fail('unavailable', new Error('IndexedDB did not open in time')), openTimeoutMs);
      const fail = (reason: BufferFailureReason, error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new BufferError(reason, error));
      };
      request.onupgradeneeded = (event) => {
        const transaction = request.transaction;
        if (transaction === null) return;
        try {
          for (let version = event.oldVersion; version < schema.length; version++) {
            schema[version]?.(request.result, transaction);
          }
        } catch (error) {
          // The upgrade is all or nothing: the database stays at its old version, with its data.
          fail('failed', error);
          transaction.abort();
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          // Gave up already (timeout, blocked): do not keep a connection nobody uses.
          db.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        const forget = () => {
          if (connection === opening) connection = undefined;
        };
        // Another tab wants to upgrade: step aside, the next call reopens.
        db.onversionchange = () => {
          db.close();
          forget();
        };
        // The browser closed the connection (storage cleared…): the next call reopens.
        db.onclose = forget;
        resolve(db);
      };
      request.onerror = () => {
        const error = request.error;
        // A database newer than this code is not "unavailable": this tab must be reloaded.
        fail(error?.name === 'VersionError' ? 'failed' : 'unavailable', error);
      };
      request.onblocked = () => fail('blocked', new Error('Another tab keeps an older version of the database open'));
    });
    // A failed open is tried again on the next call.
    opening.catch(() => {
      if (connection === opening) connection = undefined;
    });
    return opening;
  };

  const database = (): Promise<IDBDatabase> => (connection ??= open());

  /** Runs `operation` after every call made before it, and turns any failure into a result. */
  const enqueue = <T>(operation: (db: IDBDatabase) => Promise<T>, onFailure: (failure: BufferFailure) => T) => {
    if (closed) {
      return Promise.resolve(
        onFailure(failure(new BufferError('unavailable', new Error('The local buffer is closed')))),
      );
    }
    const run = tail.then(async () => {
      try {
        return await operation(await database());
      } catch (error) {
        return onFailure(failure(error));
      }
    });
    tail = run;
    return run;
  };

  return {
    get: (key) =>
      enqueue<GetResult>(
        (db) =>
          transact(db, 'readonly', (store) => {
            const request = store.get(key);
            return () => ({ ok: true, entry: toEntry(request.result) });
          }),
        (failed) => ({ ...failed, entry: undefined }),
      ),

    put: (key, { content, base }) => {
      const record: BufferEntry = {
        key,
        content,
        base: base === null ? null : { content: base.content, draftVersion: base.draftVersion },
        updatedAt: now(),
      };
      return enqueue<PutResult>(
        (db) =>
          transact(db, 'readwrite', (store) => {
            store.put(record);
            return () => ({ ok: true });
          }),
        (failed) => failed,
      );
    },

    delete: (key, condition) =>
      enqueue<DeleteResult>(
        (db) =>
          transact(db, 'readwrite', (store) => {
            let deleted = false;
            const request = store.get(key);
            request.onsuccess = () => {
              if (request.result === undefined) return;
              if (condition !== undefined && toEntry(request.result)?.content !== condition.ifContent) return;
              store.delete(key);
              deleted = true;
            };
            return () => ({ ok: true, deleted });
          }),
        (failed) => ({ ...failed, deleted: false }),
      ),

    list: () =>
      enqueue<ListResult>(
        (db) =>
          transact(db, 'readonly', (store) => {
            const request = store.getAll();
            return () => {
              const entries = (request.result as unknown[])
                .map(toEntry)
                .filter((entry): entry is BufferEntry => entry !== undefined)
                .sort((a, b) => b.updatedAt - a.updatedAt);
              return { ok: true, entries };
            };
          }),
        (failed) => ({ ...failed, entries: [] }),
      ),

    close: async () => {
      if (closed) return;
      closed = true;
      await tail;
      const pending = connection;
      connection = undefined;
      if (pending === undefined) return;
      try {
        (await pending).close();
      } catch {
        // It never opened: nothing to close.
      }
    },
  };
};
