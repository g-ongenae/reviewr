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
 * `deviceLocalBuffer()` gives it `expo-sqlite`, the tests give it Node's `node:sqlite`, so the same SQL runs in both.
 *
 * **One buffer, one connection, one statement at a time, for the life of the process.** It is never replaced:
 * `deviceLocalBuffer()` always answers the same one. Every call goes through one queue, and a call starts only once
 * the one before it settled, so an older write can never land after a newer one.
 *
 * Guarantees:
 *
 * - **Call order.** The last `put` for a key wins even when calls overlap, a `delete` made before a later `put` never
 *   removes that later text, and a read sees every write made before it.
 * - **A put that answered `ok` is on disk.** Each write is one SQL statement, so an entry is the old one or the new
 *   one, never part of each, even if the app is killed during the write; commits are synced (`synchronous = FULL`).
 * - **Texts stored exactly.** Every text (key, content, base, page) is stored as JSON with every character outside
 *   printable ASCII escaped (`encodeText`), so the native layer only ever sees printable ASCII. `expo-sqlite` on iOS
 *   binds strings up to their first NUL and cannot carry a lone surrogate; neither can alter the stored value. Equal
 *   texts always encode the same, and different texts differently (composed and decomposed accents stay distinct).
 * - **Conditional delete.** `delete(key, { ifContent })` removes the entry only if it still holds exactly that text,
 *   compared in the same statement on the encoded form. A condition that is given but holds no string is refused.
 * - **A row it cannot read is reported, kept, and never overwritten by a routine write.** A row whose key, text, base
 *   or page is not exactly what `put` writes makes `get` answer `unreadable`, is listed in `list`'s `unreadable`, and
 *   makes a `put` for its key answer `unreadable` without writing. Only an explicit `discardUnreadable(rowid)` (or an
 *   unconditional `delete(key)`) removes it.
 * - **Never throws.** Every call resolves with `{ ok: false, reason }` on failure, which the app can show as one notice
 *   ("this text is not kept on this device"); reads then answer "nothing stored". The buffer holds no text of its own.
 *   A failed open is tried again by the next call.
 * - **Stalls are reported, and they end.** A call that the database does not answer within `operationTimeoutMs`
 *   (opening included) answers `stalled`. Its statement may still be running: `expo-sqlite` cannot cancel it, so its
 *   outcome is unknown until the next write for that key succeeds. Nothing runs beside it: the calls already waiting
 *   answer `stalled` and are dropped, and every call made while it runs answers `stalled` at once, without being
 *   kept, so memory stays bounded however long it lasts. A call whose time ran out before its statement started (the
 *   database was still opening) never starts it. Once the hung statement settles, the queue works again: the next
 *   `put` writes the latest text and the next confirmation deletes it, without a restart.
 * - **Versioned schema.** `PRAGMA user_version` is the number of schema steps applied. Opening applies the missing
 *   steps of `localBufferSchema` in one transaction, so an upgrade happens entirely or not at all and buffered text is
 *   kept across it. Later versions (the outbox) append a step. A database whose version this code does not know (newer
 *   than its schema, or invalid) is never changed: every call answers `unsupported`.
 * - **`close()` is for tests and shutdown only,** and bounded by `closeTimeoutMs`: it lets the calls made before it
 *   finish, then closes the connection, and answers `ok` only if both happened in time. A timeout answers `stalled`,
 *   a failed native close `failed`; the buffer refuses every call after `close()` in all cases.
 *
 * What the editor must do with it (the next pull request): keep the latest unsaved text in memory whatever the buffer
 * answers, show when it is not kept on the device yet (pending, `stalled`) or not at all (other failures), and write it
 * again on the next edit or when the buffer answers again; a statement that timed out has an unknown outcome until the
 * next successful write for that key.
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

/** A stored row this code cannot read. It stays in the database until `discardUnreadable(rowid)`. */
export interface UnreadableRow {
  /** The decoded key, or the stored key as text when the key itself does not decode. */
  key: string;
  /** The row's SQLite `rowid`, for `discardUnreadable`. */
  rowid: number;
  error: unknown;
}

/**
 * Why a call failed:
 *
 * - `unavailable`: the database could not be opened, or the buffer was closed;
 * - `quota`: the storage is full;
 * - `unsupported`: the database was written by a newer build of the app (or its version is invalid); it is left as it
 *   is;
 * - `unreadable`: the row for this key exists but does not decode; it is left as it is;
 * - `failed`: anything else (a statement or a schema step failed, an invalid argument…);
 * - `stalled`: the database did not answer in time, or is still busy with a call that did not; nothing was written by
 *   this call, except a statement that had already started (its outcome is then unknown).
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
/** `ok` only if the calls made before `close()` finished and the connection closed, within `closeTimeoutMs`. */
export type CloseResult = { ok: true } | BufferFailure;

export interface DeleteCondition {
  /** Delete only if the stored content is exactly this text (the content the server confirmed). */
  ifContent: string;
}

export interface LocalBuffer {
  /** Reads the entry for `key`. */
  get(key: string): Promise<GetResult>;
  /**
   * Stores the latest text for `key` and the base it started from (or its page), replacing what was there, unless
   * what is there cannot be read (`unreadable`).
   */
  put(key: string, value: { content: string; base: BufferBase | null; page?: BufferPage }): Promise<PutResult>;
  /** Removes the entry for `key`, unconditionally or only if it still holds `condition.ifContent`. */
  delete(key: string, condition?: DeleteCondition): Promise<DeleteResult>;
  /** Every entry, the most recently written first, and the rows that cannot be read. */
  list(): Promise<ListResult>;
  /** Removes a row `list` reported as unreadable, only if it still cannot be read. */
  discardUnreadable(rowid: number): Promise<DeleteResult>;
  /** Refuses new calls, lets the earlier ones finish, closes the connection. Every call gets the same promise. */
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

/**
 * The text `encodeText` stored, or `undefined` when `stored` is not exactly the encoding of a text: another spelling of
 * the same text (`"\\u0061"` for `a`) is refused too, since lookups and conditional deletes compare encoded forms.
 */
export const decodeText = (stored: unknown): string | undefined => {
  if (typeof stored !== 'string' || !stored.startsWith('"')) return undefined;
  try {
    const text: unknown = JSON.parse(stored);
    return typeof text === 'string' && encodeText(text) === stored ? text : undefined;
  } catch {
    return undefined;
  }
};

export interface LocalBufferOptions {
  /** Opens the connection. Called again by the next call after it failed. */
  open: () => Promise<SqlDatabase>;
  /** Defaults to `localBufferSchema`; tests pass a longer one to simulate an upgrade. */
  schema?: readonly Migration[];
  /** How long a call (opening included) may run before it answers `stalled`. Defaults to 10 s. */
  operationTimeoutMs?: number;
  /** How long `close()` may take in all (the calls before it, then the native close). Defaults to 10 s. */
  closeTimeoutMs?: number;
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
  const page: BufferPage = title === undefined ? { creation } : { creation, title };
  // Only the spelling `put` writes: anything else was not written by this code.
  return encodePage(page) === stored ? page : undefined;
};

const encodePage = ({ creation, title }: BufferPage) =>
  encodeText(JSON.stringify(title === undefined ? { creation } : { creation, title }));

type Decoded = { entry: BufferEntry } | { unreadable: UnreadableRow };

/** Decodes a stored row. Anything that does not decode makes the whole row unreadable, never silently partial. */
const decodeRow = (row: unknown): Decoded => {
  const record = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
  const { rowid, key: storedKey, content, base_content, base_draft_version, page, updated_at } = record;
  const key = decodeText(storedKey);
  const unreadable = (what: string): Decoded => ({
    unreadable: {
      key: key ?? (typeof storedKey === 'string' ? storedKey : String(storedKey)),
      rowid: typeof rowid === 'number' ? rowid : Number(rowid),
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
  if (page !== null && page !== undefined) {
    // `put` never writes a page next to a base.
    const decoded = base === null ? decodePage(page) : undefined;
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

const SELECT = `SELECT rowid, ${COLUMNS} FROM drafts`;

/** One call: its operation, and how to answer its caller (the first answer wins). */
interface Call {
  run: (db: SqlDatabase) => Promise<void>;
  fail: (failure: BufferFailure) => void;
}

export const openLocalBuffer = (options: LocalBufferOptions): LocalBuffer => {
  const {
    open,
    schema = localBufferSchema,
    operationTimeoutMs = 10_000,
    closeTimeoutMs = 10_000,
    now = () => Date.now(),
  } = options;

  let connection: Promise<SqlDatabase> | undefined;
  let closing: Promise<CloseResult> | undefined;
  /** The calls waiting for their turn, and the one running. */
  const waiting: Call[] = [];
  let running: Call | undefined;
  /** The running call did not answer in time: until it settles, every other call answers `stalled`. */
  let hung = false;
  /** Called once nothing runs and nothing waits. */
  let onIdle: (() => void) | undefined;

  const stalledError = () => new BufferError('stalled', new Error('The database did not answer in time'));

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
    // A failed open is tried again by the next call.
    opening.catch(() => {
      if (connection === opening) connection = undefined;
    });
    return opening;
  };

  /** Starts the next call if none runs. */
  const pump = () => {
    if (running !== undefined) return;
    const call = waiting.shift();
    if (call === undefined) {
      onIdle?.();
      return;
    }
    running = call;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      hung = true;
      call.fail(failure(stalledError()));
      // Nothing may run beside the hung statement, and nothing is kept while it runs.
      for (const queued of waiting.splice(0)) queued.fail(failure(stalledError()));
    }, operationTimeoutMs);
    void (async () => {
      try {
        const db = await (connection ??= connect());
        // Its time ran out while the database was opening: the statement never starts late.
        if (!timedOut) await call.run(db);
      } catch (error) {
        call.fail(failure(error));
      } finally {
        clearTimeout(timer);
        running = undefined;
        hung = false;
        pump();
      }
    })();
  };

  /** Queues `operation`; answers at once when the buffer is closed or busy with a hung statement. */
  const enqueue = <T>(operation: (db: SqlDatabase) => Promise<T>, onFailure: (failure: BufferFailure) => T) =>
    new Promise<T>((resolve) => {
      let answered = false;
      const answer = (value: T) => {
        if (answered) return;
        answered = true;
        resolve(value);
      };
      const fail = (failed: BufferFailure) => answer(onFailure(failed));
      if (closing !== undefined)
        return fail(failure(new BufferError('unavailable', new Error('The local buffer is closed'))));
      if (hung) return fail(failure(stalledError()));
      waiting.push({ run: async (db) => answer(await operation(db)), fail });
      pump();
    });

  /** Answers a failure without queuing, for an argument refused before any SQL. */
  const refuse = <T>(error: unknown, onFailure: (failure: BufferFailure) => T) =>
    Promise.resolve(onFailure(failure(error)));

  const keyOf = (key: unknown) => {
    if (typeof key !== 'string') throw invalid('The key must be a string');
    return encodeText(key);
  };

  return {
    get: (key) => {
      const onFailure = (failed: BufferFailure): GetResult => ({ ...failed, entry: undefined });
      let storedKey: string;
      try {
        storedKey = keyOf(key);
      } catch (error) {
        return refuse(error, onFailure);
      }
      return enqueue<GetResult>(async (db) => {
        const [row] = await db.all(`${SELECT} WHERE key = ?`, [storedKey]);
        if (row === undefined) return { ok: true, entry: undefined };
        const decoded = decodeRow(row);
        if ('entry' in decoded) return { ok: true, entry: decoded.entry };
        return { ok: false, reason: 'unreadable', error: decoded.unreadable.error, entry: undefined };
      }, onFailure);
    },

    put: (key, value) => {
      // Snapshot and check the value now: the caller may change its object before the write runs.
      let params: SqlValue[];
      try {
        const { content, base, page } = value;
        if (typeof content !== 'string') throw invalid('The text must be a string');
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
            storedPage = encodePage(title === undefined ? { creation } : { creation, title });
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
          keyOf(key),
          encodeText(content),
          base === null ? null : encodeText(base.content),
          base === null ? null : base.draftVersion,
          storedPage,
          now(),
        ];
      } catch (error) {
        return refuse(error, (failed): PutResult => failed);
      }
      return enqueue<PutResult>(
        async (db) => {
          // A row that cannot be read is kept for recovery, never replaced by a routine write.
          const [row] = await db.all(`${SELECT} WHERE key = ?`, [params[0] ?? null]);
          if (row !== undefined) {
            const decoded = decodeRow(row);
            if ('unreadable' in decoded) return { ok: false, reason: 'unreadable', error: decoded.unreadable.error };
          }
          await db.run(
            `INSERT INTO drafts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET content = excluded.content, base_content = excluded.base_content,
               base_draft_version = excluded.base_draft_version, page = excluded.page,
               updated_at = excluded.updated_at`,
            params,
          );
          return { ok: true };
        },
        (failed) => failed,
      );
    },

    delete: (key, condition) => {
      const onFailure = (failed: BufferFailure): DeleteResult => ({ ...failed, deleted: false });
      // Snapshot the condition now. A condition that is given must hold a text: anything else is refused, never read
      // as "delete whatever is stored".
      let storedKey: string;
      let storedContent: string | undefined;
      try {
        storedKey = keyOf(key);
        if (condition !== undefined) {
          const ifContent: unknown = (condition as { ifContent?: unknown } | null)?.ifContent;
          if (typeof ifContent !== 'string') throw invalid('A delete condition must hold the confirmed text');
          storedContent = encodeText(ifContent);
        }
      } catch (error) {
        return refuse(error, onFailure);
      }
      return enqueue<DeleteResult>(async (db) => {
        // One statement: the check and the delete cannot be split by a write.
        const { changes } =
          storedContent === undefined
            ? await db.run('DELETE FROM drafts WHERE key = ?', [storedKey])
            : await db.run('DELETE FROM drafts WHERE key = ? AND content = ?', [storedKey, storedContent]);
        return { ok: true, deleted: changes > 0 };
      }, onFailure);
    },

    list: () =>
      enqueue<ListResult>(
        async (db) => {
          const entries: BufferEntry[] = [];
          const unreadable: UnreadableRow[] = [];
          for (const row of await db.all(`${SELECT} ORDER BY updated_at DESC, key`, [])) {
            const decoded = decodeRow(row);
            if ('entry' in decoded) entries.push(decoded.entry);
            else unreadable.push(decoded.unreadable);
          }
          return { ok: true, entries, unreadable };
        },
        (failed) => ({ ...failed, entries: [], unreadable: [] }),
      ),

    discardUnreadable: (rowid) => {
      const onFailure = (failed: BufferFailure): DeleteResult => ({ ...failed, deleted: false });
      if (typeof rowid !== 'number' || !Number.isInteger(rowid)) {
        return refuse(invalid('The rowid must be an integer'), onFailure);
      }
      return enqueue<DeleteResult>(async (db) => {
        const [row] = await db.all(`${SELECT} WHERE rowid = ?`, [rowid]);
        // Gone, or readable (written again since): nothing to discard.
        if (row === undefined || 'entry' in decodeRow(row)) return { ok: true, deleted: false };
        const { changes } = await db.run('DELETE FROM drafts WHERE rowid = ?', [rowid]);
        return { ok: true, deleted: changes > 0 };
      }, onFailure);
    },

    close: () =>
      (closing ??= (async (): Promise<CloseResult> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<CloseResult>((resolve) => {
          timer = setTimeout(
            () => resolve(failure(new BufferError('stalled', new Error('The local buffer did not close in time')))),
            closeTimeoutMs,
          );
        });
        const shutdown = (async (): Promise<CloseResult> => {
          // The calls made before `close()` finish first.
          if (running !== undefined || waiting.length > 0) {
            await new Promise<void>((resolve) => {
              onIdle = resolve;
            });
          }
          const pending = connection;
          connection = undefined;
          if (pending === undefined) return { ok: true };
          let db: SqlDatabase;
          try {
            db = await pending;
          } catch {
            return { ok: true }; // It never opened: nothing to close.
          }
          try {
            await db.close();
            return { ok: true };
          } catch (error) {
            return failure(error);
          }
        })();
        const result = await Promise.race([shutdown, deadline]);
        clearTimeout(timer);
        return result;
      })()),
  };
};
