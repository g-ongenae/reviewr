/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Document } from '@reviewr/shared';
import { ApiError, NetworkError } from '@reviewr/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppDrafts } from './documentCache';
import type { DraftsApi } from './drafts';
import { FakeApi } from './fakeApi';
import { decodeText, encodeText, openLocalBuffer, type LocalBuffer, type SqlDatabase } from './localBuffer';
import { nodeSqlDatabase } from './nodeSqlDatabase';
import { queryKeys } from './queryKeys';

const debounceMs = 1000;
const offline = new NetworkError(new TypeError('Network request failed'));
const base = { content: 'A', draftVersion: 1 };

let dir: string;
let path: string;
const opened: LocalBuffer[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'reviewr-copy-'));
  path = join(dir, 'buffer.db');
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((buffer) => buffer.close()));
  rmSync(dir, { recursive: true, force: true });
});

/** Lets the timers run for `ms`, and every answer settle. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** The row of a document as the database file holds it, read outside the app. */
const rawRow = (key = 'doc'): Record<string, unknown> | undefined => {
  const db = new DatabaseSync(path);
  try {
    return db.prepare('SELECT * FROM drafts WHERE key = ?').get(encodeText(key)) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
};

/** What the buffer holds for the document, decoded. */
const stored = (key = 'doc') => {
  const row = rawRow(key);
  if (row === undefined) return undefined;
  return {
    content: decodeText(row.content) ?? '<unreadable>',
    base: decodeText(row.base_content),
    draftVersion: row.base_draft_version,
  };
};

/** Writes rows as an earlier run of the app would have, through a buffer of its own, closed afterwards. */
const seed = async (rows: Record<string, { content: string; base: { content: string; draftVersion: number } }>) => {
  const buffer = openLocalBuffer({ open: async () => nodeSqlDatabase(path) });
  for (const [key, value] of Object.entries(rows)) expect(await buffer.put(key, value)).toEqual({ ok: true });
  await buffer.close();
};

/** The scan of the buffer: the only statement that lists every row. */
const isScan = (sql: string) => sql.includes('ORDER BY');
const isWrite = (sql: string) => /^\s*(INSERT|DELETE)/.test(sql);

/**
 * A connection whose statements can be held or failed one at a time (`before`), and that counts the writes reaching
 * SQLite. `broken` fails every statement, as a storage that stopped working.
 */
const controlled = () => {
  const control = {
    writes: 0,
    broken: false,
    before: undefined as ((sql: string) => Promise<void> | void) | undefined,
  };
  const open = async (): Promise<SqlDatabase> => {
    const db = nodeSqlDatabase(path);
    const guard =
      <A extends [string, ...unknown[]], R>(call: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        if (control.broken) throw new Error('disk I/O error');
        await control.before?.(args[0]);
        if (isWrite(args[0])) control.writes++;
        return call(...args);
      };
    return { exec: guard(db.exec), run: guard(db.run), all: guard(db.all), close: db.close };
  };
  return { control, open };
};

/** A statement held until `release` (or failed with `fail`). */
const hold = () => {
  let release!: () => void;
  let fail!: (error: unknown) => void;
  const held = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { held, release, fail };
};

/**
 * One start of the app: a new query client and registry on the test's database file, as after the app was killed. The
 * server outlives it.
 */
const start = (server: DraftsApi, connection = controlled()) => {
  const buffer = openLocalBuffer({ open: connection.open });
  opened.push(buffer);
  const queryClient = new QueryClient();
  const report = { reportSuccess: () => undefined, reportError: () => undefined };
  const app = createAppDrafts(queryClient, { api: server, report, debounceMs, buffer });
  const fetch = (id = 'doc') =>
    queryClient.fetchQuery({
      queryKey: queryKeys.document(id),
      queryFn: () => app.fetchDocument(id),
      staleTime: 0,
      retry: false,
    });
  /** Opens the document as its screen does: read it, open its entry, hold it. */
  const show = async () => {
    const document: Document = await fetch();
    const entry = app.drafts.open(document);
    app.drafts.hold('doc');
    return { entry, state: () => entry.autosave.getSnapshot() };
  };
  /** The app is killed: nothing more runs. */
  const kill = async () => {
    const entry = app.drafts.get('doc');
    entry?.autosave.dispose();
    entry?.title.dispose();
    opened.splice(opened.indexOf(buffer), 1);
    await buffer.close();
  };
  return { app, show, fetch, kill, copy: app.copy!, control: connection.control };
};

/** A first run that kept `content` on the base `A@1`, then was killed. */
const killedWith = async (content: string) => seed({ doc: { content, base } });

describe('the local buffer, from the editor', () => {
  it('writes every edit with its base, and deletes it once the server confirmed the text', async () => {
    const server = new FakeApi('A');
    const { show, copy } = start(server);
    const { entry, state } = await show();
    expect(stored()).toBeUndefined();

    entry.autosave.edit('A and B');
    await copy.settled();
    expect(stored()).toEqual({ content: 'A and B', base: 'A', draftVersion: 1 });

    server.paused = true;
    await wait(debounceMs);
    // Typed during the request: written, never deleted by the answer for the text before it.
    entry.autosave.edit('A and B and C');
    server.release();
    await wait();
    await copy.settled();
    expect(state().status).toBe('saving');
    expect(stored()).toEqual({ content: 'A and B and C', base: 'A and B', draftVersion: 2 });

    server.paused = false;
    server.release();
    await wait();
    await copy.settled();
    expect(state()).toMatchObject({ status: 'saved', content: 'A and B and C' });
    expect(stored()).toBeUndefined();
    expect(copy.failure()).toBeUndefined();
  });

  it('coalesces the texts typed while a write runs: only the newest is written after it', async () => {
    const server = new FakeApi('A');
    const app = start(server);
    const { entry } = await app.show();
    server.failing = offline;
    const first = hold();
    app.control.before = (sql) => (isWrite(sql) ? first.held : undefined);
    entry.autosave.edit('A1');
    await wait();
    for (const text of ['A12', 'A123', 'A1234']) entry.autosave.edit(text);
    app.control.before = undefined;
    first.release();
    await app.copy.settled();
    expect(app.control.writes).toBe(2);
    expect(stored()?.content).toBe('A1234');
  });

  it('deletes a text the writer undid: nothing comes back at the next start, and nothing is sent', async () => {
    const server = new FakeApi('A');
    const first = start(server);
    const { entry, state } = await first.show();
    entry.autosave.edit('A and B');
    await first.copy.settled();
    expect(stored()?.content).toBe('A and B');
    // Undone before the save: the machine is saved without a request.
    entry.autosave.edit('A');
    expect(state().status).toBe('saved');
    await first.copy.settled();
    expect(stored()).toBeUndefined();
    await first.kill();

    const second = start(server);
    const { state: restored } = await second.show();
    await wait(debounceMs);
    expect(restored()).toMatchObject({ status: 'saved', content: 'A' });
    expect(server.log.filter((request) => request.startsWith('saveDraft'))).toEqual([]);
  });

  /** A restart after an undo back to `A`: nothing comes back, and nothing is sent. */
  const restartsOnA = async (server: FakeApi) => {
    const second = start(server);
    const { state } = await second.show();
    await wait(debounceMs);
    expect(state()).toMatchObject({ status: 'saved', content: 'A' });
    expect(server.log.filter((request) => request.startsWith('saveDraft'))).toEqual([]);
  };

  it('tries a failed clean-up again on its own after an undo, without another edit', async () => {
    const server = new FakeApi('A');
    const first = start(server);
    const { entry, state } = await first.show();
    entry.autosave.edit('A and B');
    await first.copy.settled();
    let failures = 1;
    first.control.before = (sql) => {
      if (/^\s*DELETE/.test(sql) && failures-- > 0) throw new Error('disk I/O error');
    };
    entry.autosave.edit('A');
    expect(state().status).toBe('saved');
    await first.copy.settled();
    expect(stored()?.content).toBe('A and B');
    // Nothing else changes in the editor: the clean-up runs again after its backoff.
    await wait(1000);
    await first.copy.settled();
    expect(stored()).toBeUndefined();
    await first.kill();
    await restartsOnA(server);
  });

  it('deletes a text whose put timed out and committed after the undo', async () => {
    const server = new FakeApi('A');
    const first = start(server);
    const { entry, state } = await first.show();
    const insert = hold();
    first.control.before = (sql) => (/^\s*INSERT/.test(sql) ? insert.held : undefined);
    entry.autosave.edit('A and B');
    await wait();
    // Undone while SQLite still runs the INSERT: saved without a request.
    entry.autosave.edit('A');
    expect(state().status).toBe('saved');
    // The put answers `stalled` after 10 s; the clean-up meets the hung statement and answers `stalled` too.
    await wait(10_000);
    expect(first.copy.failure()).toBe('stalled');
    // The INSERT commits late.
    insert.release();
    await wait();
    expect(stored()?.content).toBe('A and B');
    // The clean-up runs again, and deletes the row holding exactly the text whose put timed out.
    await wait(1000);
    await first.copy.settled();
    expect(stored()).toBeUndefined();
    await first.kill();
    await restartsOnA(server);
  });

  it('brings back a text typed offline after the app was killed, and saves it once the server is back', async () => {
    const server = new FakeApi('A');
    const first = start(server);
    const { entry, state } = await first.show();
    server.failing = offline;
    entry.autosave.edit('Written offline');
    await wait(debounceMs);
    expect(state().status).toBe('retrying');
    await first.copy.settled();
    await first.kill();

    // The app starts again, still offline: the document cannot be read, and the text stays on the phone.
    const second = start(server);
    await expect(second.fetch()).rejects.toBe(offline);
    expect(second.app.drafts.get('doc')).toBeUndefined();
    expect(stored()?.content).toBe('Written offline');

    // The server is back: opening the document brings the text back as the local text, and it is saved.
    server.failing = undefined;
    const { state: restored } = await second.show();
    expect(restored().content).toBe('Written offline');
    await wait(debounceMs);
    expect(restored()).toMatchObject({ status: 'saved', content: 'Written offline' });
    expect(server.draft).toMatchObject({ content: 'Written offline', draftVersion: 2 });
    await second.copy.settled();
    expect(stored()).toBeUndefined();
  });

  it('brings back the first text of a document with no version yet, and saves it as its draft', async () => {
    const server = FakeApi.draftOnly();
    const first = start(server);
    const { entry } = await first.show();
    server.failing = offline;
    entry.autosave.edit('First words, offline');
    await wait(debounceMs);
    await first.copy.settled();
    expect(stored()).toEqual({ content: 'First words, offline', base: '', draftVersion: 1 });
    await first.kill();

    server.failing = undefined;
    const second = start(server);
    const { state } = await second.show();
    expect(state().content).toBe('First words, offline');
    await wait(debounceMs);
    expect(state()).toMatchObject({ status: 'saved', content: 'First words, offline' });
    expect(server.document).toMatchObject({ revision: 0, draft: { content: 'First words, offline', draftVersion: 2 } });
    expect(server.revisions).toEqual([]);
  });

  it('tries a kept text again when the document is opened again, after a read that failed for another reason', async () => {
    const server = new FakeApi('A');
    await killedWith('Kept');
    const app = start(server);
    server.failing = new ApiError(500, { statusCode: 500, message: 'Internal server error' });
    await expect(app.fetch()).rejects.toBe(server.failing);
    expect(stored()?.content).toBe('Kept');
    server.failing = undefined;
    const { state } = await app.show();
    expect(state().content).toBe('Kept');
  });

  it('runs the usual conflict, on the right base, when the server moved while the app was dead', async () => {
    const server = new FakeApi('A');
    await killedWith('Mine');
    server.otherDevice('Theirs');
    const app = start(server);
    const { state } = await app.show();
    await wait(debounceMs);
    expect(state()).toMatchObject({
      status: 'conflict',
      content: 'Mine',
      base: { content: 'A', draftVersion: 1 },
      server: { content: 'Theirs', draftVersion: 2 },
    });
    // Nothing was overwritten, either way.
    expect(server.draft.content).toBe('Theirs');
    expect(server.log.filter((request) => request.startsWith('saveDraft'))).toEqual([]);
    await app.copy.settled();
    expect(stored()?.content).toBe('Mine');

    await app.app.drafts.keepMine('doc');
    await wait();
    expect(server.revisions.map((revision) => revision.content)).toContain('Theirs');
    expect(server.draft.content).toBe('Mine');
    await app.copy.settled();
    expect(stored()).toBeUndefined();
  });

  it('sends the kept text on a newer counter with the same text, without a conflict', async () => {
    const server = new FakeApi('A');
    await killedWith('A, then more');
    server.document.draft = { ...server.draft, draftVersion: 2 };
    const app = start(server);
    const { state } = await app.show();
    await wait(debounceMs);
    expect(state()).toMatchObject({ status: 'saved', content: 'A, then more' });
    expect(server.draft).toMatchObject({ content: 'A, then more', draftVersion: 3 });
  });

  it('drops a kept text the server already holds (its answer was lost), without sending it', async () => {
    const server = new FakeApi('A');
    await killedWith('Sent');
    server.otherDevice('Sent');
    const app = start(server);
    const { state } = await app.show();
    await app.copy.settled();
    expect(stored()).toBeUndefined();
    expect(state()).toMatchObject({ status: 'saved', content: 'Sent' });
    expect(server.log.filter((request) => request.startsWith('saveDraft'))).toEqual([]);
  });

  it('does not let one unanswered read hold back another document', async () => {
    const server = new FakeApi('A');
    await seed({ doc: { content: 'Kept here', base }, other: { content: 'Kept there', base } });
    const api: DraftsApi = {
      getDocument: (id) => (id === 'other' ? new Promise<Document>(() => undefined) : server.getDocument()),
      saveDraft: (id, input) => server.saveDraft(id, input),
      createRevision: (id, input) => server.createRevision(id, input),
      renameDocument: (id, title) => server.renameDocument(id, title),
    };
    const app = start(api);
    void app.fetch('other');
    const { state } = await app.show();
    expect(state().content).toBe('Kept here');
    expect(stored('other')?.content).toBe('Kept there');
  });

  it('never deletes a row it cannot read: not on a confirmation, not when the document is deleted', async () => {
    const server = new FakeApi('A');
    await seed({ unrelated: { content: 'x', base } });
    // A row of the document this build cannot read (a newer build's, or damaged).
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO drafts (key, content, updated_at) VALUES (?, ?, 1)').run(encodeText('doc'), 'not a text');
    db.close();

    const app = start(server);
    const { entry, state } = await app.show();
    entry.autosave.edit('Mine');
    await app.copy.settled();
    expect(app.copy.failure()).toBe('unreadable');
    await wait(debounceMs);
    expect(state()).toMatchObject({ status: 'saved', content: 'Mine' });
    await app.copy.settled();
    expect(rawRow()?.content).toBe('not a text');

    app.app.drafts.discard('doc');
    await app.copy.settled();
    expect(rawRow()?.content).toBe('not a text');
  });

  it('writes nothing before the scan answered, and nothing at all once it failed', async () => {
    const server = new FakeApi('A');
    await killedWith('Kept');
    const connection = controlled();
    const scan = hold();
    connection.control.before = (sql) => (isScan(sql) ? scan.held : undefined);
    const app = start(server, connection);
    // A document opened before the scan answered (as a document just created is), and typed in.
    const entry = app.app.drafts.open({ ...server.read(), id: 'new' });
    app.app.drafts.hold('new');
    entry.autosave.edit('Early');
    await wait();
    expect(app.control.writes).toBe(0);

    scan.fail(new Error('disk I/O error'));
    await app.copy.settled();
    entry.autosave.edit('Early, and more');
    await wait(debounceMs);
    await app.copy.settled();
    expect(app.control.writes).toBe(0);
    expect(app.copy.failure()).toBe('failed');
    expect(stored()?.content).toBe('Kept');
    // The text still goes to the server.
    await wait();
    expect(server.draft.content).toBe('Early, and more');
  });

  it('writes what was typed before the scan answered once it did', async () => {
    const server = new FakeApi('A');
    const connection = controlled();
    const scan = hold();
    connection.control.before = (sql) => (isScan(sql) ? scan.held : undefined);
    const app = start(server, connection);
    const entry = app.app.drafts.open(server.read());
    app.app.drafts.hold('doc');
    server.failing = offline;
    entry.autosave.edit('Early');
    await wait();
    expect(app.control.writes).toBe(0);
    scan.release();
    await app.copy.settled();
    expect(stored()?.content).toBe('Early');
  });

  it('opens documents without touching the buffer when it cannot be read, and restores its text next time', async () => {
    const server = new FakeApi('A');
    await killedWith('Kept');
    const broken = controlled();
    broken.control.broken = true;
    const second = start(server, broken);
    const { entry, state } = await second.show();
    expect(state().content).toBe('A');
    expect(second.copy.failure()).toBeDefined();
    entry.autosave.edit('New');
    await wait(debounceMs);
    await second.copy.settled();
    expect(server.draft.content).toBe('New');
    expect(stored()?.content).toBe('Kept');
    await second.kill();

    // The next start brings it back: the server moved meanwhile, so it is a conflict, never a replacement.
    const third = start(server);
    const { state: restored } = await third.show();
    await wait(debounceMs);
    expect(restored()).toMatchObject({ status: 'conflict', content: 'Kept', server: { content: 'New' } });
    expect(server.draft.content).toBe('New');
  });

  it('tells the writer once when a write fails, keeps the text on screen and retried, and writes it again', async () => {
    const server = new FakeApi('A');
    const app = start(server);
    const { entry, state } = await app.show();
    server.failing = offline;
    const heard = vi.fn();
    app.copy.subscribe(heard);

    app.control.before = (sql) => {
      if (isWrite(sql)) throw new Error('disk I/O error');
    };
    entry.autosave.edit('Not kept');
    await app.copy.settled();
    expect(app.copy.failure()).toBe('failed');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ status: 'unsaved', content: 'Not kept' });

    entry.autosave.edit('Not kept, still');
    await wait(debounceMs);
    await app.copy.settled();
    expect(state()).toMatchObject({ status: 'retrying', content: 'Not kept, still' });
    expect(heard).toHaveBeenCalledTimes(1);

    // The disk answers again: the autosave's next retry writes the newest text.
    app.control.before = undefined;
    await wait(1000);
    await app.copy.settled();
    expect(stored()?.content).toBe('Not kept, still');

    server.failing = undefined;
    await wait(2000);
    await app.copy.settled();
    expect(server.draft.content).toBe('Not kept, still');
    expect(stored()).toBeUndefined();

    app.copy.dismiss();
    expect(app.copy.dismissed()).toBe(true);
  });

  it('deletes its own row once confirmed, even when the write before the confirmation failed', async () => {
    const server = new FakeApi('A');
    const app = start(server);
    const { entry, state } = await app.show();
    entry.autosave.edit('Old');
    await app.copy.settled();
    expect(stored()?.content).toBe('Old');
    app.control.before = (sql) => {
      if (isWrite(sql)) throw new Error('disk I/O error');
    };
    entry.autosave.edit('New');
    await app.copy.settled();
    app.control.before = undefined;
    await wait(debounceMs);
    await app.copy.settled();
    expect(state()).toMatchObject({ status: 'saved', content: 'New' });
    expect(stored()).toBeUndefined();
  });

  it('opens documents as without a buffer when the buffer cannot be opened at all', async () => {
    const server = new FakeApi('A');
    const buffer = openLocalBuffer({ open: () => Promise.reject(new Error('Cannot find native module ExpoSQLite')) });
    opened.push(buffer);
    const app = createAppDrafts(new QueryClient(), {
      api: server,
      report: { reportSuccess: () => undefined, reportError: () => undefined },
      debounceMs,
      buffer,
    });
    const entry = app.drafts.open(await app.fetchDocument('doc'));
    expect(app.copy?.failure()).toBe('unavailable');
    app.drafts.hold('doc');
    entry.autosave.edit('Still saved');
    await wait(debounceMs);
    expect(server.draft.content).toBe('Still saved');
  });

  it('removes the row of a document the writer deleted', async () => {
    const server = new FakeApi('A');
    const app = start(server);
    const { entry } = await app.show();
    server.failing = offline;
    entry.autosave.edit('Gone with it');
    await app.copy.settled();
    expect(stored()).toBeDefined();
    app.app.drafts.discard('doc');
    await app.copy.settled();
    expect(stored()).toBeUndefined();
  });
});
