/**
 * The local buffer: the text being written, kept in SQLite on the phone until the server confirmed it.
 *
 * It keeps, for each document, the writer's latest text and the **base** it started from (the server draft content and
 * `draftVersion` the edits were made on), so the text can be restored after the app was killed or a request failed,
 * and compared three-way with the server's draft later. The key names the document, which may not exist on the server
 * yet: its `base` is then `null`, and its `page` holds what its creation needs.
 *
 * The same contract as the web's `apps/web/src/autosave/localBuffer.ts`, on SQLite and for one process. It is
 * framework-free (no React, no HTTP) and talks to the database through `SqlDatabase`, a narrow interface:
 * `openDeviceLocalBuffer` (in `deviceLocalBuffer.ts`) gives it `expo-sqlite`, the tests give it Node's `node:sqlite`, so
 * the same SQL runs in both.
 *
 * Guarantees:
 *
 * - **Call order.** Every call runs in the order it was made, one after the other: the last `put` for a key wins even
 *   when calls overlap, a `delete` made before a later `put` never removes that later text, and a read sees every
 *   write made before it.
 * - **Conditional delete.** `delete(key, { ifContent })` removes the entry only if it still holds exactly that text,
 *   checked in the same statement. Delete with the content the server confirmed: text typed while the save was in
 *   flight stays in the buffer.
 * - **All or nothing.** Each write is one SQL statement, so an entry is the old one or the new one, never part of each,
 *   even if the app is killed during the write. Commits are synced to disk (`synchronous = FULL`): a write that
 *   answered `ok` survives the app being killed and the phone losing power.
 * - **Never throws.** Every call resolves, never rejects. When the database cannot be opened, is full, or fails, the
 *   result is `{ ok: false, reason }`, which the app can show as one notice ("this text is not kept on this device");
 *   reads then answer "nothing stored" (`entry: undefined`, `entries: []`). The buffer holds no text of its own, so a
 *   failure discards nothing the editor holds. A failed open is tried again on the next call, and so is a connection
 *   dropped after an error it could not recover from.
 * - **Versioned schema.** `PRAGMA user_version` is the number of schema steps applied. Opening applies the missing
 *   steps of `localBufferSchema` in one transaction, so an upgrade happens entirely or not at all and buffered text is
 *   kept across it. Later versions (the outbox) append a step. A database whose version this code does not know (newer
 *   than its schema, or invalid) is never changed: every call answers `unsupported`, and the text stays on disk for
 *   the build that wrote it.
 * - **A stalled call stops the buffer, loudly.** A call the database does not answer within `operationTimeoutMs`
 *   answers `stalled`. Whether it will still commit is then unknown, so no later write may run after it (it could
 *   commit over newer text): from then on, this buffer answers `stalled` to every call, including the ones already
 *   queued, until the app opens a new one. `close()` still resolves.
 *
 * Left out, compared with the web: the phone runs one process, so there are no locks between tabs, no per-tab copies
 * of an entry, and no step aside for an upgrade made by another tab.
 *
 * Not done yet:
 *
 * - **Outbox.** Pending operations (create, save draft, save version, rename) and their replay on reconnect are a
 *   separate table, added by a later schema step.
 */

/** The server draft the local edits started from. */
export interface BufferBase {
  content: string;
  draftVersion: number;
}

/**
 * What restoring a page whose document does not exist on the server yet needs: its id is in the key (chosen by the
 * client), and its creation must be sent again exactly as it may already have been sent.
 */
export interface BufferPage {
  /** The text of the creation already sent (its body's `content`), sent again unchanged; `null` if none was sent. */
  creation: string | null;
  /** A title typed on the page, not saved yet. */
  title?: string;
}

/** What the buffer stores per key. */
export interface BufferEntry {
  /** The document id, or a client-made key for a document not created on the server yet. */
  key: string;
  /** The writer's latest text. */
  content: string;
  /** The server draft the edits started from; `null` for a document not created on the server yet. */
  base: BufferBase | null;
  /** Only with `base: null`: what the creation of the document needs. */
  page?: BufferPage;
  /** When the entry was written, in milliseconds since the epoch. */
  updatedAt: number;
}

/**
 * Why a call failed:
 *
 * - `unavailable`: the database could not be opened, or the buffer was closed;
 * - `quota`: the storage is full;
 * - `unsupported`: the database was written by a newer build of the app (or its version is invalid); it is left as it
 *   is;
 * - `failed`: anything else (a statement or a schema step failed…);
 * - `stalled`: a call never settled; this buffer stopped and answers `stalled` to every later call.
 */
export type BufferFailureReason = 'unavailable' | 'quota' | 'unsupported' | 'failed' | 'stalled';

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
  /** Stores the latest text for `key` and the base it started from (or its page), replacing what was there. */
  put(key: string, value: { content: string; base: BufferBase | null; page?: BufferPage }): Promise<PutResult>;
  /** Removes the entry for `key`, unconditionally or only if it still holds `condition.ifContent`. */
  delete(key: string, condition?: DeleteCondition): Promise<DeleteResult>;
  /** Every entry, the most recently written first. */
  list(): Promise<ListResult>;
  /** Closes the database once the pending calls are done. Calls made after it fail as `unavailable`. */
  close(): Promise<void>;
}

/** A value bound to a statement's `?` placeholder. */
export type SqlValue = string | number | null;

/**
 * The part of a SQLite connection the buffer uses. Statements run one at a time: the buffer never starts one before
 * the previous one settled.
 */
export interface SqlDatabase {
  /** Runs one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  /** Runs one statement and answers how many rows it changed. */
  run(sql: string, params: readonly SqlValue[]): Promise<{ changes: number }>;
  /** Runs one query and answers its rows, as objects keyed by column name. */
  all(sql: string, params: readonly SqlValue[]): Promise<unknown[]>;
  close(): Promise<void>;
}

/** One schema step: run, inside the upgrade's transaction, when upgrading from version `index` to `index + 1`. */
export type Migration = (db: SqlDatabase) => Promise<void>;

/** The schema: the database version is its length. Append to it, never edit a step that shipped. */
export const localBufferSchema: readonly Migration[] = [
  // 1: the buffered drafts, keyed by document id or client-made key. `page` is JSON, only without a base.
  (db) =>
    db.exec(
      `CREATE TABLE drafts (
        key TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL,
        base_content TEXT,
        base_draft_version INTEGER,
        page TEXT,
        updated_at INTEGER NOT NULL
      )`,
    ),
];

export interface LocalBufferOptions {
  /** Opens the connection. Called again on the next call after it failed, or after the connection was dropped. */
  open: () => Promise<SqlDatabase>;
  /** Defaults to `localBufferSchema`; tests pass a longer one to simulate an upgrade. */
  schema?: readonly Migration[];
  /** How long a call (opening included) may stay unsettled before the buffer stops as `stalled`. Defaults to 10 s. */
  operationTimeoutMs?: number;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

class BufferError extends Error {
  readonly reason: BufferFailureReason;
  readonly error: unknown;

  constructor(reason: BufferFailureReason, error: unknown) {
    super(`Local buffer ${reason}`);
    this.reason = reason;
    this.error = error;
  }
}

/** SQLite's "database or disk is full" (`SQLITE_FULL`), as `expo-sqlite` and `node:sqlite` report it. */
const isFull = (error: unknown): boolean => {
  const { message, errcode, code } = (error ?? {}) as { message?: unknown; errcode?: unknown; code?: unknown };
  return (
    errcode === 13 ||
    code === 'SQLITE_FULL' ||
    (typeof message === 'string' && /SQLITE_FULL|database or disk is full/i.test(message))
  );
};

const failure = (error: unknown): BufferFailure => {
  if (error instanceof BufferError) return { ok: false, reason: error.reason, error: error.error };
  return { ok: false, reason: isFull(error) ? 'quota' : 'failed', error };
};

const toPage = (value: unknown): BufferPage | undefined => {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { creation, title } = parsed as Record<string, unknown>;
  if (creation !== null && typeof creation !== 'string') return undefined;
  return typeof title === 'string' ? { creation, title } : { creation };
};

/**
 * Reads a stored row defensively: whatever holds text is returned, a malformed base becomes `null`, and a page is read
 * only without a base (a malformed one is left out).
 */
const toEntry = (row: unknown): BufferEntry | undefined => {
  if (typeof row !== 'object' || row === null) return undefined;
  const { key, content, base_content, base_draft_version, page, updated_at } = row as Record<string, unknown>;
  if (typeof key !== 'string' || typeof content !== 'string') return undefined;
  const entry: BufferEntry = {
    key,
    content,
    base:
      typeof base_content === 'string' && typeof base_draft_version === 'number'
        ? { content: base_content, draftVersion: base_draft_version }
        : null,
    updatedAt: typeof updated_at === 'number' ? updated_at : 0,
  };
  const pageOf = entry.base === null ? toPage(page) : undefined;
  return pageOf === undefined ? entry : { ...entry, page: pageOf };
};

const COLUMNS = 'key, content, base_content, base_draft_version, page, updated_at';

/** Ends a transaction that failed. Answers `false` if it could not, which leaves the connection in an unknown state. */
const rollback = async (db: SqlDatabase): Promise<boolean> => {
  try {
    await db.exec('ROLLBACK');
    return true;
  } catch {
    return false;
  }
};

/** Brings the database to `schema.length`, in one transaction, or leaves it as it was. */
const upgrade = async (db: SqlDatabase, schema: readonly Migration[]) => {
  // FULL: every commit is synced to disk, also in WAL mode, before the write answers `ok`.
  await db.exec('PRAGMA synchronous = FULL');
  // IMMEDIATE: the version read below cannot change before the steps are written.
  await db.exec('BEGIN IMMEDIATE');
  try {
    const [row] = await db.all('PRAGMA user_version', []);
    const version = (row as { user_version?: unknown } | undefined)?.user_version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > schema.length) {
      throw new BufferError(
        'unsupported',
        new Error(`The local buffer is at schema version ${String(version)}; this build knows ${schema.length}`),
      );
    }
    for (let step = version; step < schema.length; step++) await schema[step]?.(db);
    // A pragma takes no parameter; the length is a number this code controls.
    if (version < schema.length) await db.exec(`PRAGMA user_version = ${schema.length}`);
    await db.exec('COMMIT');
  } catch (error) {
    await rollback(db);
    throw error;
  }
};

export const openLocalBuffer = (options: LocalBufferOptions): LocalBuffer => {
  const { open, schema = localBufferSchema, operationTimeoutMs = 10_000, now = () => Date.now() } = options;

  let connection: Promise<SqlDatabase> | undefined;
  let closed = false;
  /** Set once a call did not settle: every later call answers `stalled`. */
  let stalled: BufferError | undefined;
  /** The end of the queue: every call runs after the previous one settled. */
  let tail: Promise<unknown> = Promise.resolve();

  /** Forgets the connection and closes it, ignoring errors: the next call opens a new one. */
  const drop = async (pending: Promise<SqlDatabase>) => {
    if (connection === pending) connection = undefined;
    try {
      await (await pending).close();
    } catch {
      // Already closed, or never opened.
    }
  };

  const connect = (): Promise<SqlDatabase> => {
    const opening = (async () => {
      let db: SqlDatabase;
      try {
        db = await open();
      } catch (error) {
        throw new BufferError('unavailable', error);
      }
      try {
        await upgrade(db, schema);
      } catch (error) {
        await db.close().catch(() => undefined);
        throw error;
      }
      return db;
    })();
    // A failed open is tried again on the next call.
    opening.catch(() => {
      if (connection === opening) connection = undefined;
    });
    return opening;
  };

  const database = (): Promise<SqlDatabase> => (connection ??= connect());

  /** Why a new call is refused right away, if it is. */
  const refusal = (): BufferError | undefined =>
    stalled ?? (closed ? new BufferError('unavailable', new Error('The local buffer is closed')) : undefined);

  /** Settles with `operation`, or rejects as `stalled` once `operationTimeoutMs` passed. */
  const withTimeout = <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BufferError('stalled', new Error('The database did not answer in time'))),
        operationTimeoutMs,
      );
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  };

  /** Runs `operation` after every call made before it, and turns any failure into a result. */
  const enqueue = <T>(operation: (db: SqlDatabase) => Promise<T>, onFailure: (failure: BufferFailure) => T) => {
    const refused = refusal();
    if (refused !== undefined) return Promise.resolve(onFailure(failure(refused)));
    const run = tail.then(async () => {
      try {
        // Queued behind a call that stalled: never run after it.
        if (stalled !== undefined) throw stalled;
        return await withTimeout(database().then(operation));
      } catch (error) {
        if (error instanceof BufferError && error.reason === 'stalled') stalled = error;
        return onFailure(failure(error));
      }
    });
    tail = run;
    return run;
  };

  /**
   * Runs statements on `db`. SQLite undoes a failed statement on its own; the connection is then closed, so that the
   * next call starts on a new one (after an I/O error, a file removed underneath…).
   */
  const statement = async <T>(db: SqlDatabase, body: () => Promise<T>): Promise<T> => {
    try {
      return await body();
    } catch (error) {
      if (connection !== undefined) await drop(connection);
      throw error;
    }
  };

  return {
    get: (key) =>
      enqueue<GetResult>(
        (db) =>
          statement(db, async () => {
            const [row] = await db.all(`SELECT ${COLUMNS} FROM drafts WHERE key = ?`, [key]);
            return { ok: true, entry: toEntry(row) };
          }),
        (failed) => ({ ...failed, entry: undefined }),
      ),

    put: (key, value) => {
      const refused = refusal();
      if (refused !== undefined) return Promise.resolve(failure(refused));
      // Snapshot the value now: the caller may change its object before the write runs.
      let params: SqlValue[];
      try {
        const { content, base, page } = value;
        const pageJson =
          base === null && page !== undefined
            ? JSON.stringify(
                page.title === undefined ? { creation: page.creation } : { creation: page.creation, title: page.title },
              )
            : null;
        params = [
          key,
          content,
          base === null ? null : base.content,
          base === null ? null : base.draftVersion,
          pageJson,
          now(),
        ];
      } catch (error) {
        return Promise.resolve(failure(error));
      }
      return enqueue<PutResult>(
        (db) =>
          statement(db, async () => {
            await db.run(
              `INSERT INTO drafts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET content = excluded.content, base_content = excluded.base_content,
                 base_draft_version = excluded.base_draft_version, page = excluded.page,
                 updated_at = excluded.updated_at`,
              params,
            );
            return { ok: true };
          }),
        (failed) => failed,
      );
    },

    delete: (key, condition) => {
      // Snapshot the condition now: the caller may change its object before the delete runs.
      let ifContent: string | undefined;
      try {
        ifContent = condition === undefined ? undefined : condition.ifContent;
      } catch (error) {
        return Promise.resolve({ ...failure(error), deleted: false });
      }
      return enqueue<DeleteResult>(
        (db) =>
          statement(db, async () => {
            // One statement: the check and the delete cannot be split by a write.
            const { changes } =
              ifContent === undefined
                ? await db.run('DELETE FROM drafts WHERE key = ?', [key])
                : await db.run('DELETE FROM drafts WHERE key = ? AND content = ?', [key, ifContent]);
            return { ok: true, deleted: changes > 0 };
          }),
        (failed) => ({ ...failed, deleted: false }),
      );
    },

    list: () =>
      enqueue<ListResult>(
        (db) =>
          statement(db, async () => {
            const rows = await db.all(`SELECT ${COLUMNS} FROM drafts ORDER BY updated_at DESC, key`, []);
            const entries = rows.map(toEntry).filter((entry): entry is BufferEntry => entry !== undefined);
            return { ok: true, entries };
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
        await (await pending).close();
      } catch {
        // It never opened, or is already closed: nothing to close.
      }
    },
  };
};
