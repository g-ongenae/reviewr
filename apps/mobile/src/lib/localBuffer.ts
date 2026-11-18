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
 * - **Texts stored exactly.** Every text (key, content, base, page) is stored as JSON with every character outside
 *   printable ASCII escaped (`encodeText`), so the native layer only ever sees printable ASCII. `expo-sqlite` on iOS
 *   binds strings up to their first NUL and cannot carry a lone surrogate; neither can alter the stored value. Equal
 *   texts always encode the same, and different texts differently (composed and decomposed accents stay distinct).
 * - **Conditional delete.** `delete(key, { ifContent })` removes the entry only if it still holds exactly that text,
 *   compared in the same statement on the encoded form. Delete with the content the server confirmed: text typed
 *   while the save was in flight stays in the buffer. A condition that is given but holds no string is refused, never
 *   read as "no condition".
 * - **All or nothing.** Each write is one SQL statement, so an entry is the old one or the new one, never part of each,
 *   even if the app is killed during the write. Commits are synced to disk (`synchronous = FULL`): a write that
 *   answered `ok` survives the app being killed and the phone losing power.
 * - **Never throws.** Every call resolves, never rejects. When the database cannot be opened, is full, or fails, the
 *   result is `{ ok: false, reason }`, which the app can show as one notice ("this text is not kept on this device");
 *   reads then answer "nothing stored" (`entry: undefined`, `entries: []`). The buffer holds no text of its own, so a
 *   failure discards nothing the editor holds. A failed open is tried again on the next call, and so is a connection
 *   dropped after a failed statement.
 * - **A row it cannot read is reported, never hidden.** A row whose key, text, base or page does not decode (a BLOB in
 *   a text column, a value not written by this code) makes `get` answer `unreadable` with its key, and is listed in
 *   `list`'s `unreadable`. The row is left as it is.
 * - **Versioned schema.** `PRAGMA user_version` is the number of schema steps applied. Opening applies the missing
 *   steps of `localBufferSchema` in one transaction, so an upgrade happens entirely or not at all and buffered text is
 *   kept across it. Later versions (the outbox) append a step. A database whose version this code does not know (newer
 *   than its schema, or invalid) is never changed: every call answers `unsupported`, and the text stays on disk for
 *   the build that wrote it.
 * - **A stalled call stops the buffer, loudly, and never writes late.** A call the database does not answer within
 *   `operationTimeoutMs` (opening included) answers `stalled`, and so does every call after it, queued or new: whether
 *   the stalled work will still commit is unknown, and a later write must not land before it. A call whose time ran
 *   out before its statement started never starts it. The work itself is tracked apart from the answers: `close()`
 *   (one shared promise, whoever calls it) waits for it to settle, then closes the connection, and answers whether it
 *   could (`drained`). A buffer opened with `previous` (the old buffer's `close()`) waits for that before opening the
 *   database; if the old work could not be drained, every call answers `stalled` until the app restarts, since
 *   `expo-sqlite` cannot cancel a statement it started.
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

/** A stored row this code cannot read. It stays in the database. */
export interface UnreadableRow {
  /** The decoded key, or the stored key as text when the key itself does not decode. */
  key: string;
  error: unknown;
}

/**
 * Why a call failed:
 *
 * - `unavailable`: the database could not be opened, or the buffer was closed;
 * - `quota`: the storage is full;
 * - `unsupported`: the database was written by a newer build of the app (or its version is invalid); it is left as it
 *   is;
 * - `unreadable`: (`get` only) the row exists but does not decode; it is left as it is;
 * - `failed`: anything else (a statement or a schema step failed, an invalid argument…);
 * - `stalled`: a call never settled, or the buffer before this one could not be drained; this buffer answers `stalled`
 *   to every later call. Only a restart of the app makes the database usable again in the second case.
 */
export type BufferFailureReason = 'unavailable' | 'quota' | 'unsupported' | 'unreadable' | 'failed' | 'stalled';

export interface BufferFailure {
  ok: false;
  reason: BufferFailureReason;
  error: unknown;
}

export type GetResult = { ok: true; entry: BufferEntry | undefined } | (BufferFailure & { entry: undefined });
/** `unreadable` lists the rows that exist but do not decode; `entries` holds every other one. */
export type ListResult =
  { ok: true; entries: BufferEntry[]; unreadable: UnreadableRow[] } | (BufferFailure & { entries: []; unreadable: [] });
export type PutResult = { ok: true } | BufferFailure;
/** `deleted` is `false` when there was nothing to delete or the stored text was not `ifContent`. */
export type DeleteResult = { ok: true; deleted: boolean } | (BufferFailure & { deleted: false });

/**
 * How `close()` ended: `drained` is `false` when the work already started did not settle within `drainTimeoutMs`, or
 * when this buffer itself replaced one that could not be drained. The connection is then closed whenever the work
 * settles, and no other buffer may write to the database before the app restarts (a buffer opened with this as
 * `previous` answers `stalled`, and so does the next one).
 */
export interface CloseResult {
  drained: boolean;
}

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
  /** Every entry, the most recently written first, and the rows that cannot be read. */
  list(): Promise<ListResult>;
  /**
   * Refuses new calls (`unavailable`), waits for the work already started, then closes the database. Every call gets
   * the same promise.
   */
  close(): Promise<CloseResult>;
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
  // 1: the buffered drafts. Every TEXT column holds `encodeText` of its value (`page`: the encoded JSON of the page,
  // only without a base), so that only printable ASCII crosses the native layer.
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

/** Escapes every character outside printable ASCII in JSON text (code unit by code unit, lone surrogates included). */
const toAscii = (json: string) =>
  json.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A text as stored: its JSON string literal, in printable ASCII. One text, one encoding. */
export const encodeText = (text: string): string => toAscii(JSON.stringify(text));

/** The text `encodeText` stored, or `undefined` when `stored` is not one. */
export const decodeText = (stored: unknown): string | undefined => {
  if (typeof stored !== 'string' || !stored.startsWith('"')) return undefined;
  try {
    const text: unknown = JSON.parse(stored);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
};

export interface LocalBufferOptions {
  /** Opens the connection. Called again on the next call after it failed, or after the connection was dropped. */
  open: () => Promise<SqlDatabase>;
  /**
   * The `close()` of the buffer this one replaces on the same database: the database is opened only once it drained.
   * If it could not, every call answers `stalled`.
   */
  previous?: Promise<CloseResult>;
  /** Defaults to `localBufferSchema`; tests pass a longer one to simulate an upgrade. */
  schema?: readonly Migration[];
  /** How long a call (opening included) may stay unsettled before the buffer stops as `stalled`. Defaults to 10 s. */
  operationTimeoutMs?: number;
  /** How long `close()` waits for the work already started. Defaults to 10 s. */
  drainTimeoutMs?: number;
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

const invalid = (message: string) => new BufferError('failed', new TypeError(message));

const decodePage = (stored: unknown): BufferPage | undefined => {
  const json = decodeText(stored);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { creation, title } = parsed as Record<string, unknown>;
  if (creation !== null && typeof creation !== 'string') return undefined;
  if (title !== undefined && typeof title !== 'string') return undefined;
  return title === undefined ? { creation } : { creation, title };
};

type Decoded = { entry: BufferEntry } | { unreadable: UnreadableRow };

/** Decodes a stored row. Anything that does not decode makes the whole row unreadable, never silently partial. */
const decodeRow = (row: unknown): Decoded => {
  const record = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
  const { key: storedKey, content, base_content, base_draft_version, page, updated_at } = record;
  const key = decodeText(storedKey);
  const unreadable = (what: string): Decoded => ({
    unreadable: {
      key: key ?? (typeof storedKey === 'string' ? storedKey : String(storedKey)),
      error: new Error(`The buffered ${what} cannot be read`),
    },
  });
  if (key === undefined) return unreadable('key');
  const text = decodeText(content);
  if (text === undefined) return unreadable('text');
  let base: BufferBase | null = null;
  if (base_content !== null || base_draft_version !== null) {
    const baseText = decodeText(base_content);
    if (baseText === undefined || typeof base_draft_version !== 'number' || !Number.isInteger(base_draft_version)) {
      return unreadable('base');
    }
    base = { content: baseText, draftVersion: base_draft_version };
  }
  const entry: BufferEntry = { key, content: text, base, updatedAt: typeof updated_at === 'number' ? updated_at : 0 };
  // A page is only kept without a base; one stored with a base (never written so) is ignored.
  if (base === null && page !== null && page !== undefined) {
    const decoded = decodePage(page);
    if (decoded === undefined) return unreadable('page');
    entry.page = decoded;
  }
  return { entry };
};

const COLUMNS = 'key, content, base_content, base_draft_version, page, updated_at';

/** Ends a transaction that failed, ignoring errors. */
const rollback = async (db: SqlDatabase) => {
  try {
    await db.exec('ROLLBACK');
  } catch {
    // No transaction left, or the connection is gone: nothing more to undo.
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

const settle = (promise: Promise<unknown>): Promise<void> =>
  promise.then(
    () => undefined,
    () => undefined,
  );

export const openLocalBuffer = (options: LocalBufferOptions): LocalBuffer => {
  const {
    open,
    previous,
    schema = localBufferSchema,
    operationTimeoutMs = 10_000,
    drainTimeoutMs = 10_000,
    now = () => Date.now(),
  } = options;

  let connection: Promise<SqlDatabase> | undefined;
  let closing: Promise<CloseResult> | undefined;
  /** The buffer before this one could not drain: this one cannot vouch for the database either. */
  let inheritedUndrained = false;
  /** Set once a call did not settle in time (or the previous buffer did not drain): every later call answers it. */
  let stalled: BufferError | undefined;
  /** Rejects once `stalled` is set, so that calls queued behind stalled work answer at once. */
  let signalStall: (error: BufferError) => void = () => undefined;
  const stall = new Promise<never>((_, reject) => {
    signalStall = reject;
  });
  stall.catch(() => undefined);
  const stop = (error: BufferError) => {
    if (stalled !== undefined) return;
    stalled = error;
    signalStall(error);
  };
  /**
   * The work itself, apart from the answers: each call's work starts once the previous one settled, even if that one
   * was already answered `stalled`. `close()` drains it.
   */
  let work: Promise<void> =
    previous === undefined
      ? Promise.resolve()
      : settle(
          previous.then((result) => {
            if (!result.drained) {
              inheritedUndrained = true;
              stop(
                new BufferError(
                  'stalled',
                  new Error('The previous local buffer could not finish its writes; restart the app'),
                ),
              );
            }
          }),
        );

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

  /** Why a new call is refused right away, if it is. */
  const refusal = (): BufferError | undefined =>
    stalled ??
    (closing !== undefined ? new BufferError('unavailable', new Error('The local buffer is closed')) : undefined);

  /**
   * Runs `operation` after the work of every call made before it, and turns any failure into a result. The call's
   * time starts with its turn; once it runs out, the buffer stops, and the operation is not started if it was still
   * waiting for the database.
   */
  const enqueue = <T>(operation: (db: SqlDatabase) => Promise<T>, onFailure: (failure: BufferFailure) => T) => {
    const refused = refusal();
    if (refused !== undefined) return Promise.resolve(onFailure(failure(refused)));
    const job = work.then(async () => {
      if (stalled !== undefined) throw stalled;
      const timer = setTimeout(
        () => stop(new BufferError('stalled', new Error('The database did not answer in time'))),
        operationTimeoutMs,
      );
      try {
        const db = await (connection ??= connect());
        // Its time ran out while the database was opening: the statement must never start late.
        if (stalled !== undefined) throw stalled;
        return await operation(db);
      } finally {
        clearTimeout(timer);
      }
    });
    work = settle(job);
    return Promise.race([job, stall]).catch((error: unknown) => onFailure(failure(error)));
  };

  /**
   * Runs statements on `db`. SQLite undoes a failed statement on its own; the connection is then closed, so that the
   * next call starts on a new one (after an I/O error, a file removed underneath…).
   */
  const statement = async <T>(body: () => Promise<T>): Promise<T> => {
    try {
      return await body();
    } catch (error) {
      if (connection !== undefined) await drop(connection);
      throw error;
    }
  };

  return {
    get: (key) => {
      let storedKey: string;
      try {
        if (typeof key !== 'string') throw invalid('The key must be a string');
        storedKey = encodeText(key);
      } catch (error) {
        return Promise.resolve({ ...failure(error), entry: undefined });
      }
      return enqueue<GetResult>(
        (db) =>
          statement(async () => {
            const [row] = await db.all(`SELECT ${COLUMNS} FROM drafts WHERE key = ?`, [storedKey]);
            if (row === undefined) return { ok: true, entry: undefined };
            const decoded = decodeRow(row);
            if ('entry' in decoded) return { ok: true, entry: decoded.entry };
            return { ok: false, reason: 'unreadable', error: decoded.unreadable.error, entry: undefined };
          }),
        (failed) => ({ ...failed, entry: undefined }),
      );
    },

    put: (key, value) => {
      const refused = refusal();
      if (refused !== undefined) return Promise.resolve(failure(refused));
      // Snapshot and check the value now: the caller may change its object before the write runs.
      let params: SqlValue[];
      try {
        const { content, base, page } = value;
        if (typeof key !== 'string' || typeof content !== 'string') throw invalid('The key and text must be strings');
        let storedPage: string | null = null;
        if (base === null) {
          if (page !== undefined) {
            const { creation, title } = page;
            if (
              (creation !== null && typeof creation !== 'string') ||
              (title !== undefined && typeof title !== 'string')
            ) {
              throw invalid('The page holds a value that is not text');
            }
            storedPage = encodeText(JSON.stringify(title === undefined ? { creation } : { creation, title }));
          }
        } else if (
          typeof base !== 'object' ||
          typeof base.content !== 'string' ||
          typeof base.draftVersion !== 'number' ||
          !Number.isInteger(base.draftVersion)
        ) {
          throw invalid('The base must hold a text and an integer draftVersion');
        }
        params = [
          encodeText(key),
          encodeText(content),
          base === null ? null : encodeText(base.content),
          base === null ? null : base.draftVersion,
          storedPage,
          now(),
        ];
      } catch (error) {
        return Promise.resolve(failure(error));
      }
      return enqueue<PutResult>(
        (db) =>
          statement(async () => {
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
      // Snapshot the condition now: the caller may change its object before the delete runs. A condition that is
      // given must hold a text: anything else is refused, never read as "delete whatever is stored".
      let storedKey: string;
      let storedContent: string | undefined;
      try {
        if (typeof key !== 'string') throw invalid('The key must be a string');
        storedKey = encodeText(key);
        if (condition !== undefined) {
          const ifContent: unknown = (condition as { ifContent?: unknown } | null)?.ifContent;
          if (typeof ifContent !== 'string') throw invalid('A delete condition must hold the confirmed text');
          storedContent = encodeText(ifContent);
        }
      } catch (error) {
        return Promise.resolve({ ...failure(error), deleted: false });
      }
      return enqueue<DeleteResult>(
        (db) =>
          statement(async () => {
            // One statement: the check and the delete cannot be split by a write.
            const { changes } =
              storedContent === undefined
                ? await db.run('DELETE FROM drafts WHERE key = ?', [storedKey])
                : await db.run('DELETE FROM drafts WHERE key = ? AND content = ?', [storedKey, storedContent]);
            return { ok: true, deleted: changes > 0 };
          }),
        (failed) => ({ ...failed, deleted: false }),
      );
    },

    list: () =>
      enqueue<ListResult>(
        (db) =>
          statement(async () => {
            const rows = await db.all(`SELECT ${COLUMNS} FROM drafts ORDER BY updated_at DESC, key`, []);
            const entries: BufferEntry[] = [];
            const unreadable: UnreadableRow[] = [];
            for (const row of rows) {
              const decoded = decodeRow(row);
              if ('entry' in decoded) entries.push(decoded.entry);
              else unreadable.push(decoded.unreadable);
            }
            return { ok: true, entries, unreadable };
          }),
        (failed) => ({ ...failed, entries: [], unreadable: [] }),
      ),

    close: () =>
      (closing ??= (async () => {
        const shut = async () => {
          const pending = connection;
          connection = undefined;
          if (pending !== undefined) await drop(pending);
        };
        const pendingWork = work;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const drained = await Promise.race([
          pendingWork.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), drainTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
        if (!drained) {
          // Close it whenever the work settles; until then, nothing else may write (see `CloseResult`).
          void pendingWork.then(shut);
          return { drained: false };
        }
        await shut();
        return { drained: !inheritedUndrained };
      })()),
  };
};
