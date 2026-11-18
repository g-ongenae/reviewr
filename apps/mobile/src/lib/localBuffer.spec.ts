/// <reference types="node" />
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  localBufferSchema,
  openLocalBuffer,
  type LocalBuffer,
  type LocalBufferOptions,
  type Migration,
  type SqlDatabase,
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
const setup = (options: Partial<LocalBufferOptions> = {}) => {
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
      expect(inspect((db) => db.prepare('SELECT content FROM drafts').all())).toEqual([{ content: 'Before close' }]);
    });

    it('stores a page only without a base, and keeps a page without a title', async () => {
      const buffer = setup();
      await buffer.put('a', { content: 'A', base, page: { creation: 'A' } });
      await buffer.put('b', { content: 'B', base: null, page: { creation: null } });
      expect((await buffer.get('a')).entry).not.toHaveProperty('page');
      expect((await buffer.get('b')).entry?.page).toEqual({ creation: null });
    });

    it('reads a malformed row defensively: whatever holds text is returned', async () => {
      const buffer = setup();
      await buffer.put('doc', { content: 'Text', base });
      await buffer.close();
      inspect((db) => {
        db.exec(`INSERT INTO drafts VALUES ('bad-base', 'Text 2', 'Server', 'three', NULL, 5)`);
        db.exec(`INSERT INTO drafts VALUES ('bad-page', 'Text 3', NULL, NULL, '{not json', 4)`);
        db.exec(`INSERT INTO drafts VALUES ('odd-page', 'Text 4', NULL, NULL, '{"creation":3}', 3)`);
      });
      const result = await setup().list();
      expect(result.ok && result.entries.map(({ key, content, base: b, page }) => ({ key, content, b, page }))).toEqual(
        [
          { key: 'doc', content: 'Text', b: base, page: undefined },
          { key: 'bad-base', content: 'Text 2', b: null, page: undefined },
          { key: 'bad-page', content: 'Text 3', b: null, page: undefined },
          { key: 'odd-page', content: 'Text 4', b: null, page: undefined },
        ],
      );
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

    it('stops as "stalled" when a statement never settles, without running the calls queued behind it', async () => {
      let hang = false;
      let ran = 0;
      const buffer = setup({
        operationTimeoutMs: 50,
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
      await buffer.close();
    });
  });
});
