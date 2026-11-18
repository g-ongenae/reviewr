/// <reference types="node" />
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeText,
  localBufferSchema,
  openLocalBuffer,
  type DeleteCondition,
  type LocalBuffer,
  type LocalBufferOptions,
  type Migration,
  type SqlDatabase,
  type SqlValue,
} from './localBuffer';
import { nodeSqlDatabase } from './nodeSqlDatabase';

let dir: string;
let path: string;
const opened: LocalBuffer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reviewr-buffer-'));
  path = join(dir, 'buffer.db');
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((buffer) => buffer.close()));
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Each statement waits less than the one before it (40 ms, then 38…, then 0): calls run at once would land in the
 * reverse order, so the tests see the buffer's own ordering.
 */
const countdown = () => {
  let ms = 42;
  return () => (ms = Math.max(0, ms - 2));
};

/** A buffer on the test's database file, on real SQLite, whose statements answer slower the earlier they start. */
const setupBuffer = (options: Partial<LocalBufferOptions> = {}) => {
  let clock = 1000;
  const delay = countdown();
  const buffer = openLocalBuffer({
    open: async () => nodeSqlDatabase(path, { delay }),
    now: () => ++clock,
    ...options,
  });
  opened.push(buffer);
  return buffer;
};

/** The default buffer; the encoding tests shadow it with one on another binding. */
const setup = setupBuffer;

/** Reads the database file directly, outside the buffer. */
const inspect = <T>(read: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
};

const version = () =>
  inspect((db) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

const base = { content: 'Server text', draftVersion: 3 };

describe('openLocalBuffer', () => {
  it('stores the text and its base, and answers "nothing stored" for an unknown key', async () => {
    const buffer = setup();
    expect(await buffer.put('doc', { content: 'Local text', base })).toEqual({ ok: true });
    expect(await buffer.get('doc')).toEqual({
      ok: true,
      entry: { key: 'doc', content: 'Local text', base, updatedAt: 1001 },
    });
    expect(await buffer.get('other')).toEqual({ ok: true, entry: undefined });
  });

  it('lists every entry, the most recently written first', async () => {
    const buffer = setup();
    await buffer.put('a', { content: 'A', base });
    await buffer.put('b', { content: 'B', base: null });
    await buffer.put('a', { content: 'A2', base });
    const result = await buffer.list();
    expect(result.ok && result.entries.map((entry) => [entry.key, entry.content])).toEqual([
      ['a', 'A2'],
      ['b', 'B'],
    ]);
  });

  describe('call order', () => {
    it('keeps the last put when puts overlap', async () => {
      const buffer = setup();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, n) => buffer.put('doc', { content: `Text ${n}`, base })),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect((await buffer.get('doc')).entry?.content).toBe('Text 9');
    });

    it('never lets a delete remove text put after it', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Old', base });
      const [deleted] = await Promise.all([buffer.delete('doc'), buffer.put('doc', { content: 'New', base })]);
      expect(deleted).toEqual({ ok: true, deleted: true });
      expect((await buffer.get('doc')).entry?.content).toBe('New');
    });

    it('applies a put made before a delete', async () => {
      const buffer = setup();
      const [, deleted] = await Promise.all([buffer.put('doc', { content: 'Text', base }), buffer.delete('doc')]);
      expect(deleted).toEqual({ ok: true, deleted: true });
      expect((await buffer.get('doc')).entry).toBeUndefined();
    });

    it('lets a read see every write made before it', async () => {
      const buffer = setup();
      void buffer.put('doc', { content: 'One', base });
      void buffer.put('doc', { content: 'Two', base });
      expect((await buffer.get('doc')).entry?.content).toBe('Two');
    });
  });

  describe('conditional delete', () => {
    it('refuses a condition that holds no text, and keeps the entry', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Text', base });
      for (const condition of [{}, { ifContent: undefined }, { ifContent: 3 }, null]) {
        expect(await buffer.delete('doc', condition as unknown as DeleteCondition)).toMatchObject({
          ok: false,
          reason: 'failed',
          deleted: false,
        });
      }
      expect((await buffer.get('doc')).entry?.content).toBe('Text');
    });

    it('keeps text typed while the save was in flight', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Sent', base });
      await buffer.put('doc', { content: 'Sent, and typed after', base });
      expect(await buffer.delete('doc', { ifContent: 'Sent' })).toEqual({ ok: true, deleted: false });
      expect((await buffer.get('doc')).entry?.content).toBe('Sent, and typed after');
    });

    it('deletes when the stored text is the confirmed one, and only that exact text', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Sent', base });
      expect(await buffer.delete('doc', { ifContent: 'sent' })).toEqual({ ok: true, deleted: false });
      expect(await buffer.delete('doc', { ifContent: 'Sent ' })).toEqual({ ok: true, deleted: false });
      expect(await buffer.delete('doc', { ifContent: 'Sent' })).toEqual({ ok: true, deleted: true });
      expect((await buffer.get('doc')).entry).toBeUndefined();
    });

    it('never removes a newer text when the confirmation of an older one races it', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Sent', base });
      // The newer text is written, then the server's confirmation of the older one arrives, without waiting.
      const [put, deleted] = await Promise.all([
        buffer.put('doc', { content: 'Typed after', base }),
        buffer.delete('doc', { ifContent: 'Sent' }),
        buffer.put('other', { content: 'Elsewhere', base }),
      ]);
      expect(put).toEqual({ ok: true });
      expect(deleted).toEqual({ ok: true, deleted: false });
      expect((await buffer.get('doc')).entry?.content).toBe('Typed after');
    });

    it('uses the condition as it was when called, even if the caller changes it after', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Sent', base });
      const condition = { ifContent: 'Sent' };
      const deleting = buffer.delete('doc', condition);
      condition.ifContent = 'Something else';
      expect(await deleting).toEqual({ ok: true, deleted: true });
    });

    it('reports that there was nothing to delete', async () => {
      const buffer = setup();
      expect(await buffer.delete('doc')).toEqual({ ok: true, deleted: false });
      expect(await buffer.delete('doc', { ifContent: '' })).toEqual({ ok: true, deleted: false });
    });
  });

  describe('persistence', () => {
    it('keeps the text when the database is closed and opened again', async () => {
      const first = setup();
      await first.put('doc', { content: 'Kept', base });
      await first.put('page', { content: 'A new page', base: null, page: { creation: 'A new', title: 'T' } });
      await first.close();
      const second = setup();
      expect((await second.get('doc')).entry).toMatchObject({ content: 'Kept', base });
      expect((await second.get('page')).entry).toMatchObject({
        content: 'A new page',
        base: null,
        page: { creation: 'A new', title: 'T' },
      });
      expect(version()).toBe(localBufferSchema.length);
    });

    it('finishes the calls made before close, and refuses the ones made after', async () => {
      const buffer = setup();
      const writing = buffer.put('doc', { content: 'Before close', base });
      const closing = buffer.close();
      expect(await buffer.get('doc')).toMatchObject({ ok: false, reason: 'unavailable', entry: undefined });
      expect(await writing).toEqual({ ok: true });
      await closing;
      expect(inspect((db) => db.prepare('SELECT content FROM drafts').all())).toEqual([
        { content: encodeText('Before close') },
      ]);
    });

    it('stores a page only without a base, and keeps a page without a title', async () => {
      const buffer = setup();
      await buffer.put('a', { content: 'A', base, page: { creation: 'A' } });
      await buffer.put('b', { content: 'B', base: null, page: { creation: null } });
      expect((await buffer.get('a')).entry).not.toHaveProperty('page');
      expect((await buffer.get('b')).entry?.page).toEqual({ creation: null });
    });

    it('reports a row it cannot decode with its key, lists the others, and leaves it in place', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Text', base });
      await buffer.close();
      const blob = new Uint8Array([0x22, 0x41, 0x22]);
      inspect((db) => {
        const insert = db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?)');
        insert.run(encodeText('blob-text'), blob, null, null, null, 6);
        insert.run(encodeText('raw-text'), 'Not encoded', null, null, null, 5);
        insert.run(encodeText('bad-base'), encodeText('Text 2'), encodeText('Server'), 'three', null, 4);
        insert.run(encodeText('half-base'), encodeText('Text 3'), null, 3, null, 3);
        insert.run(encodeText('bad-page'), encodeText('Text 4'), null, null, encodeText('{not json'), 2);
        insert.run('raw-key', encodeText('Text 5'), null, null, null, 1);
        // Another spelling of the right text: \u0061 is `a`.
        insert.run('"\\u0061"', encodeText('Text 6'), null, null, null, 0);
        insert.run(encodeText('odd-text'), '"\\u0054ext 7"', null, null, null, -1);
        // A page next to a base, which `put` never writes.
        insert.run(
          encodeText('page-and-base'),
          encodeText('Text 8'),
          encodeText('Server'),
          1,
          encodeText('{"creation":null}'),
          -2,
        );
      });
      const before = inspect((db) => db.prepare('SELECT * FROM drafts ORDER BY key').all());

      const reader = setup();
      const result = await reader.list();
      expect(result.ok && result.entries.map((entry) => entry.key)).toEqual(['doc']);
      expect(result.ok && result.unreadable.map((row) => row.key)).toEqual([
        'blob-text',
        'raw-text',
        'bad-base',
        'half-base',
        'bad-page',
        'raw-key',
        '"\\u0061"',
        'odd-text',
        'page-and-base',
      ]);
      expect(await reader.get('a')).toEqual({ ok: true, entry: undefined });
      expect(await reader.get('odd-text')).toMatchObject({ ok: false, reason: 'unreadable' });
      expect(await reader.get('page-and-base')).toMatchObject({ ok: false, reason: 'unreadable' });
      expect(await reader.get('blob-text')).toMatchObject({ ok: false, reason: 'unreadable', entry: undefined });
      expect(await reader.get('bad-page')).toMatchObject({ ok: false, reason: 'unreadable', entry: undefined });
      await reader.close();
      expect(inspect((db) => db.prepare('SELECT * FROM drafts ORDER BY key').all())).toEqual(before);
    });

    it('never lets a routine put replace a row it cannot read; only an explicit discard removes it', async () => {
      await setup().list();
      inspect((db) =>
        db
          .prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?)')
          .run(encodeText('doc'), 'Not encoded', null, null, null, 1),
      );
      const buffer = setup();
      expect(await buffer.put('doc', { content: 'New', base })).toMatchObject({ ok: false, reason: 'unreadable' });
      expect(inspect((db) => db.prepare('SELECT content FROM drafts').all())).toEqual([{ content: 'Not encoded' }]);

      const listed = await buffer.list();
      const rowid = listed.ok ? listed.unreadable[0]?.rowid : undefined;
      expect(rowid).toEqual(expect.any(Number));
      await buffer.put('other', { content: 'Readable', base });
      const other = inspect((db) => db.prepare('SELECT rowid FROM drafts WHERE key = ?').get(encodeText('other')));
      expect(await buffer.discardUnreadable((other as { rowid: number }).rowid)).toEqual({ ok: true, deleted: false });
      expect(await buffer.discardUnreadable(rowid ?? -1)).toEqual({ ok: true, deleted: true });
      expect(await buffer.put('doc', { content: 'New', base })).toEqual({ ok: true });
      expect((await buffer.get('doc')).entry?.content).toBe('New');
    });

    it('keeps an entry whole when the app is killed during its writes', async () => {
      // A child process writes 1 MB texts in a loop, through this module, and is killed with SIGKILL mid-loop.
      const modules = {
        buffer: pathToFileURL(join(import.meta.dirname, 'localBuffer.ts')).href,
        sql: pathToFileURL(join(import.meta.dirname, 'nodeSqlDatabase.ts')).href,
      };
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--no-warnings',
          '-e',
          `
          const { openLocalBuffer } = await import(${JSON.stringify(modules.buffer)});
          const { nodeSqlDatabase } = await import(${JSON.stringify(modules.sql)});
          const buffer = openLocalBuffer({ open: async () => nodeSqlDatabase(${JSON.stringify(path)}) });
          for (let n = 0; ; n++) {
            const letter = 'abcdefghij'[n % 10];
            const result = await buffer.put('doc', { content: letter.repeat(1 << 20), base: { content: letter, draftVersion: n } });
            if (!result.ok) { console.error(result); process.exit(1); }
            // Write 3 is acknowledged: the parent kills the writer only after it.
            if (n === 3) process.stdout.write('ready\\n');
          }
          `,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      const exited = new Promise<NodeJS.Signals | number | null>((resolve) =>
        child.on('exit', (code, signal) => resolve(signal ?? code)),
      );
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', () => resolve());
        child.on('exit', () => reject(new Error('The writer exited before it was killed')));
      });
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
      child.kill('SIGKILL');
      expect(await exited).toBe('SIGKILL');

      expect(inspect((db) => db.prepare('PRAGMA integrity_check').get())).toEqual({ integrity_check: 'ok' });
      const { entry } = await setup().get('doc');
      const letter = entry?.content[0] ?? '';
      expect(entry?.content).toBe(letter.repeat(1 << 20));
      expect(entry?.base?.content).toBe(letter);
      // Never older than the last acknowledged write, and the text is the one written with that version.
      const written = entry?.base?.draftVersion ?? -1;
      expect(written).toBeGreaterThanOrEqual(3);
      expect(letter).toBe('abcdefghij'[written % 10]);
    }, 20_000);
  });

  describe('schema versions', () => {
    const outbox: Migration = (db) =>
      db.exec('CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL)');

    it('creates the schema on a new database', async () => {
      await setup().list();
      expect(version()).toBe(1);
    });

    it('keeps buffered text when a later version adds a table', async () => {
      const first = setup();
      await first.put('doc', { content: 'Before the upgrade', base });
      await first.put('page', { content: 'A page', base: null, page: { creation: null } });
      await first.close();

      const upgraded = setup({ schema: [...localBufferSchema, outbox] });
      const result = await upgraded.list();
      expect(result.ok && result.entries.map((entry) => entry.content).sort()).toEqual([
        'A page',
        'Before the upgrade',
      ]);
      expect(version()).toBe(2);
      expect(inspect((db) => db.prepare(`SELECT name FROM sqlite_master WHERE name = 'outbox'`).all())).toHaveLength(1);
    });

    it('leaves the database untouched when a step fails, and tries again on the next call', async () => {
      const first = setup();
      await first.put('doc', { content: 'Before the upgrade', base });
      await first.close();

      let fail = true;
      const flaky: Migration = async (db) => {
        await outbox(db);
        if (fail) throw new Error('step failed');
      };
      const upgraded = setup({ schema: [...localBufferSchema, flaky] });
      expect(await upgraded.get('doc')).toMatchObject({ ok: false, reason: 'failed', entry: undefined });
      expect(version()).toBe(1);
      expect(inspect((db) => db.prepare(`SELECT name FROM sqlite_master WHERE name = 'outbox'`).all())).toEqual([]);

      fail = false;
      expect((await upgraded.get('doc')).entry?.content).toBe('Before the upgrade');
      expect(version()).toBe(2);
    });

    it('never changes a database written by a newer build', async () => {
      const newer = setup({ schema: [...localBufferSchema, outbox] });
      await newer.put('doc', { content: 'Written by a newer build', base });
      await newer.close();
      const before = inspect((db) => db.prepare('SELECT * FROM drafts').all());

      const older = setup();
      for (const result of [
        await older.get('doc'),
        await older.put('doc', { content: 'Older build', base }),
        await older.delete('doc'),
        await older.list(),
      ]) {
        expect(result).toMatchObject({ ok: false, reason: 'unsupported' });
      }
      await older.close();
      expect(version()).toBe(2);
      expect(inspect((db) => db.prepare('SELECT * FROM drafts').all())).toEqual(before);
    });

    it('never changes a database whose version it does not know', async () => {
      inspect((db) => {
        db.exec('CREATE TABLE drafts (key TEXT PRIMARY KEY, content TEXT)');
        db.exec(`INSERT INTO drafts VALUES ('doc', 'Unknown layout')`);
        db.exec('PRAGMA user_version = -1');
      });
      const buffer = setup();
      expect(await buffer.put('doc', { content: 'New', base })).toMatchObject({ ok: false, reason: 'unsupported' });
      expect(await buffer.list()).toMatchObject({ ok: false, reason: 'unsupported', entries: [] });
      await buffer.close();
      expect(version()).toBe(-1);
      expect(inspect((db) => db.prepare('SELECT * FROM drafts').all())).toEqual([
        { key: 'doc', content: 'Unknown layout' },
      ]);
    });
  });

  describe('when SQLite fails', () => {
    /** The real database, with `fail` deciding which statements throw. */
    const faulty = (fail: (sql: string) => unknown) => async (): Promise<SqlDatabase> => {
      const db = nodeSqlDatabase(path);
      const check = (sql: string) => {
        const error = fail(sql);
        if (error !== undefined) throw error;
      };
      return {
        exec: async (sql) => (check(sql), db.exec(sql)),
        run: async (sql, params) => (check(sql), db.run(sql, params)),
        all: async (sql, params) => (check(sql), db.all(sql, params)),
        close: () => db.close(),
      };
    };

    it('answers "unavailable" when the database cannot be opened, and tries again on the next call', async () => {
      let attempts = 0;
      const buffer = setup({
        open: async () => {
          attempts++;
          if (attempts === 1) throw new Error('cannot open');
          return nodeSqlDatabase(path);
        },
      });
      expect(await buffer.put('doc', { content: 'Text', base })).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(await buffer.put('doc', { content: 'Text', base })).toEqual({ ok: true });
      expect(attempts).toBe(2);
    });

    it('answers "failed" when a write fails, keeps the older text, and works again on the next call', async () => {
      let failing = false;
      const buffer = setup({
        open: faulty((sql) => (failing && sql.startsWith('INSERT') ? new Error('disk I/O error') : undefined)),
      });
      await buffer.put('doc', { content: 'Older', base });
      failing = true;
      const result = await buffer.put('doc', { content: 'Newer', base });
      expect(result).toMatchObject({ ok: false, reason: 'failed' });
      expect(result.ok || (result.error as Error).message).toBe('disk I/O error');
      expect((await buffer.get('doc')).entry?.content).toBe('Older');
      failing = false;
      expect(await buffer.put('doc', { content: 'Newer', base })).toEqual({ ok: true });
      expect((await buffer.get('doc')).entry?.content).toBe('Newer');
    });

    it('answers "quota" when the storage is full, and keeps what was stored', async () => {
      const buffer = setup({
        open: async () => {
          const db = nodeSqlDatabase(path);
          // A database that cannot grow past its current pages plus a few: a real SQLITE_FULL.
          db.raw.exec('PRAGMA max_page_count = 8');
          return db;
        },
      });
      expect(await buffer.put('doc', { content: 'Small', base })).toEqual({ ok: true });
      expect(await buffer.put('doc', { content: 'x'.repeat(1 << 16), base })).toMatchObject({
        ok: false,
        reason: 'quota',
      });
      expect((await buffer.get('doc')).entry?.content).toBe('Small');
    });

    it('answers failures for every kind of call, never rejecting', async () => {
      const buffer = setup({ open: faulty(() => new Error('broken')) });
      await expect(buffer.get('doc')).resolves.toMatchObject({ ok: false, entry: undefined });
      await expect(buffer.list()).resolves.toMatchObject({ ok: false, entries: [] });
      await expect(buffer.delete('doc')).resolves.toMatchObject({ ok: false, deleted: false });
      await expect(buffer.put('doc', { content: 'Text', base })).resolves.toMatchObject({ ok: false });
    });

    it('answers a failure instead of throwing when the clock or the value throws', async () => {
      const clockless = setup({
        now: () => {
          throw new Error('clock');
        },
      });
      expect(await clockless.put('doc', { content: 'Text', base })).toMatchObject({ ok: false, reason: 'failed' });
      const buffer = setup();
      const value = {
        get content(): string {
          throw new Error('getter');
        },
        base,
      };
      expect(await buffer.put('doc', value)).toMatchObject({ ok: false, reason: 'failed' });
      const condition = {
        get ifContent(): string {
          throw new Error('getter');
        },
      };
      expect(await buffer.delete('doc', condition)).toMatchObject({ ok: false, reason: 'failed', deleted: false });
    });

    it('takes the value as it was when called, even if the caller changes it after', async () => {
      const buffer = setup();
      const value = { content: 'As called', base: { ...base } };
      const writing = buffer.put('doc', value);
      value.content = 'Changed';
      value.base.draftVersion = 99;
      await writing;
      expect((await buffer.get('doc')).entry).toMatchObject({ content: 'As called', base });
    });

    it('answers "stalled" when a statement never settles, and to every call while it runs', async () => {
      let hang = false;
      let ran = 0;
      const buffer = setup({
        operationTimeoutMs: 50,
        closeTimeoutMs: 50,
        open: async () => {
          const db = nodeSqlDatabase(path);
          return {
            ...db,
            run: (sql, params) => {
              ran++;
              return hang ? new Promise<never>(() => undefined) : db.run(sql, params);
            },
          };
        },
      });
      await buffer.put('doc', { content: 'Older', base });
      hang = true;
      const stalledPut = buffer.put('doc', { content: 'Hangs', base });
      const queued = buffer.delete('doc');
      expect(await stalledPut).toMatchObject({ ok: false, reason: 'stalled' });
      expect(await queued).toMatchObject({ ok: false, reason: 'stalled', deleted: false });
      expect(await buffer.get('doc')).toMatchObject({ ok: false, reason: 'stalled' });
      expect(ran).toBe(2);
      expect(await buffer.close()).toMatchObject({ ok: false, reason: 'stalled' });
    });
  });

  describe('stalls end', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('keeps nothing while a statement is hung, and works again once it landed', async () => {
      let late = false;
      let runs = 0;
      const buffer = setup({
        operationTimeoutMs: 50,
        open: async () => {
          const db = nodeSqlDatabase(path);
          return {
            ...db,
            // Once `late`, a statement is sent before the timeout and reaches SQLite after it.
            run: async (sql, params) => {
              runs++;
              if (late) {
                late = false;
                await sleep(150);
              }
              return db.run(sql, params);
            },
          };
        },
      });
      expect(await buffer.put('doc', { content: 'Older', base })).toEqual({ ok: true });
      late = true;
      expect(await buffer.put('doc', { content: 'Late', base })).toMatchObject({ ok: false, reason: 'stalled' });

      // While it is hung, every call answers at once and none is kept to run later.
      const during = await Promise.all(
        Array.from({ length: 1000 }, (_, n) => buffer.put('doc', { content: `During ${n}`, base })),
      );
      expect(during.every((result) => !result.ok && result.reason === 'stalled')).toBe(true);
      expect(runs).toBe(2);

      await sleep(150);
      // The late write really committed, and nothing ran after it.
      expect(inspect((db) => db.prepare('SELECT content FROM drafts').all())).toEqual([
        { content: encodeText('Late') },
      ]);
      expect(runs).toBe(2);

      expect(await buffer.put('doc', { content: 'Newer', base })).toEqual({ ok: true });
      expect((await buffer.get('doc')).entry?.content).toBe('Newer');
      expect(await buffer.delete('doc', { ifContent: 'Newer' })).toEqual({ ok: true, deleted: true });
    });

    it('recovers from a slow first open: the write that timed out never runs, the next one does', async () => {
      let runs = 0;
      const buffer = setup({
        operationTimeoutMs: 50,
        open: async () => {
          await sleep(150);
          const db = nodeSqlDatabase(path);
          return {
            ...db,
            run: (sql, params) => {
              runs++;
              return db.run(sql, params);
            },
          };
        },
      });
      expect(await buffer.put('doc', { content: 'Stale', base })).toMatchObject({ ok: false, reason: 'stalled' });
      expect(await buffer.put('doc', { content: 'Refused', base })).toMatchObject({ ok: false, reason: 'stalled' });
      await sleep(150);
      expect(runs).toBe(0);
      expect(await buffer.put('doc', { content: 'Newer', base })).toEqual({ ok: true });
      expect((await buffer.get('doc')).entry?.content).toBe('Newer');
    });
  });

  describe('close', () => {
    const closing = (close: () => Promise<void>) =>
      setup({ closeTimeoutMs: 50, open: async () => ({ ...nodeSqlDatabase(path), close }) });

    it('answers "stalled" when the native close never answers, within its bound, and refuses later calls', async () => {
      const buffer = closing(() => new Promise<never>(() => undefined));
      expect(await buffer.put('doc', { content: 'Text', base })).toEqual({ ok: true });
      const first = buffer.close();
      expect(buffer.close()).toBe(first);
      expect(await first).toMatchObject({ ok: false, reason: 'stalled' });
      expect(await buffer.put('doc', { content: 'After', base })).toMatchObject({ ok: false, reason: 'unavailable' });
    });

    it('answers "failed" when the native close fails, never a clean shutdown', async () => {
      const error = new Error('close failed');
      const buffer = closing(() => Promise.reject(error));
      await buffer.get('doc');
      expect(await buffer.close()).toEqual({ ok: false, reason: 'failed', error });
    });

    it('answers "stalled" when a call before it never finishes', async () => {
      const buffer = setup({
        operationTimeoutMs: 5000,
        closeTimeoutMs: 50,
        open: async () => ({ ...nodeSqlDatabase(path), run: () => new Promise<never>(() => undefined) }),
      });
      void buffer.put('doc', { content: 'Hangs', base });
      expect(await buffer.close()).toMatchObject({ ok: false, reason: 'stalled' });
    });

    it('answers ok once the calls before it finished and the connection closed', async () => {
      let closes = 0;
      const buffer = closing(async () => {
        closes++;
      });
      void buffer.put('doc', { content: 'Text', base });
      expect(await buffer.close()).toEqual({ ok: true });
      expect(closes).toBe(1);
    });
  });

  /**
   * Binds and reads strings as `expo-sqlite` 58 does on iOS (`sqlite3_bind_text(…, -1, …)` and `String(cString:)`): cut
   * at the first NUL, lone surrogates replaced (Swift strings hold no lone surrogate). Node binds them faithfully.
   */
  const iosLike = async (): Promise<SqlDatabase> => {
    const db = nodeSqlDatabase(path);
    const native = (value: unknown) =>
      typeof value === 'string' ? new TextDecoder().decode(new TextEncoder().encode(value.split('\u0000')[0])) : value;
    const bind = (params: readonly SqlValue[]) => params.map(native) as SqlValue[];
    return {
      ...db,
      run: (sql, params) => db.run(sql, bind(params)),
      all: async (sql, params) =>
        (await db.all(sql, bind(params))).map((row) =>
          Object.fromEntries(Object.entries(row as object).map(([column, value]) => [column, native(value)])),
        ),
    };
  };

  describe.each([
    ['Node', undefined],
    ['an iOS-like binding', iosLike],
  ])('texts stored exactly, through %s', (_, open) => {
    const setup = (options: Partial<LocalBufferOptions> = {}) =>
      setupBuffer(open === undefined ? options : { open, ...options });
    const long = 'Éte\u0301 \u0000 😀 x\ud800 '.repeat(30_000);
    const texts = {
      nul: 'A\u0000B',
      composed: 'caf\u00e9',
      decomposed: 'cafe\u0301',
      lone: 'x\ud800y',
      long,
    };

    it('reads back every text as written: the key, the text, the base and the page', async () => {
      const buffer = setup();
      for (const text of Object.values(texts)) {
        await buffer.put(text, { content: text, base: { content: text, draftVersion: 1 } });
        await buffer.put(`page ${text}`, { content: text, base: null, page: { creation: text, title: text } });
      }
      await buffer.close();
      const reader = setup();
      for (const text of Object.values(texts)) {
        const { entry } = await reader.get(text);
        expect(entry?.key).toBe(text);
        expect(entry?.content).toBe(text);
        expect(entry?.base?.content).toBe(text);
        expect((await reader.get(`page ${text}`)).entry?.page).toEqual({ creation: text, title: text });
      }
      const result = await reader.list();
      expect(result.ok && result.entries).toHaveLength(Object.keys(texts).length * 2);
    }, 30_000);

    it('sends only printable ASCII to the database', async () => {
      const buffer = setup();
      for (const text of Object.values(texts)) {
        await buffer.put(text, { content: text, base: null, page: { creation: text } });
      }
      await buffer.close();
      const values = inspect((db) => db.prepare('SELECT key, content, page FROM drafts').all()).flatMap((row) =>
        Object.values(row),
      );
      expect(values.every((value) => typeof value === 'string' && /^[\x20-\x7e]*$/.test(value))).toBe(true);
    });

    it('deletes only on the exact text: not a prefix before a NUL, another normalization or a replaced surrogate', async () => {
      const buffer = setup();
      const cases: [string, string][] = [
        [texts.nul, 'A'],
        [texts.decomposed, texts.composed],
        [texts.composed, texts.decomposed],
        [texts.lone, 'x\ufffdy'],
        [texts.long, texts.long.slice(0, -1)],
      ];
      for (const [stored, confirmed] of cases) {
        await buffer.put('doc', { content: stored, base });
        expect(await buffer.delete('doc', { ifContent: confirmed })).toEqual({ ok: true, deleted: false });
        expect((await buffer.get('doc')).entry?.content).toBe(stored);
        expect(await buffer.delete('doc', { ifContent: stored })).toEqual({ ok: true, deleted: true });
      }
    });
  });
});
