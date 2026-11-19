/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Document } from '@reviewr/shared';
import { NetworkError } from '@reviewr/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppDrafts } from './documentCache';
import { FakeApi } from './fakeApi';
import { decodeText, openLocalBuffer, type LocalBuffer, type SqlDatabase } from './localBuffer';
import { nodeSqlDatabase } from './nodeSqlDatabase';
import { queryKeys } from './queryKeys';

const debounceMs = 1000;
const offline = new NetworkError(new TypeError('Network request failed'));

let dir: string;
let path: string;
const opened: LocalBuffer[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'reviewr-kept-'));
  path = join(dir, 'buffer.db');
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((buffer) => buffer.close()));
  rmSync(dir, { recursive: true, force: true });
});

/** Lets the timers run for `ms`, and every answer settle. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** What the database file holds for the document, read outside the app. */
const stored = (): { content: string; base: string | undefined; draftVersion: unknown } | undefined => {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT * FROM drafts WHERE key = ?').get(JSON.stringify('doc')) as
      Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      content: decodeText(row.content) ?? '<unreadable>',
      base: decodeText(row.base_content),
      draftVersion: row.base_draft_version,
    };
  } finally {
    db.close();
  }
};

/** A connection that fails every statement while `broken` is true, as a full or failing storage does. */
const breakable = (db: SqlDatabase, state: { broken: boolean }): SqlDatabase => {
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      state.broken ? Promise.reject(new Error('disk I/O error')) : call(...args);
  return { exec: guard(db.exec), run: guard(db.run), all: guard(db.all), close: db.close };
};

/**
 * One start of the app: a new query client and registry on the test's database file, as after the app was killed. The
 * server outlives it. `broken` makes every statement of this start's buffer fail.
 */
const start = async (server: FakeApi, options: { broken?: { broken: boolean }; open?: boolean } = {}) => {
  const { broken = { broken: false }, open = true } = options;
  const buffer = openLocalBuffer({ open: async () => breakable(nodeSqlDatabase(path), broken) });
  opened.push(buffer);
  const queryClient = new QueryClient();
  const report = { reportSuccess: () => undefined, reportError: () => undefined };
  const app = createAppDrafts(queryClient, { api: server, report, debounceMs, buffer });
  const key = queryKeys.document('doc');
  const fetch = () =>
    queryClient.fetchQuery({ queryKey: key, queryFn: () => app.fetchDocument('doc'), staleTime: 0, retry: false });
  /** Opens the document as its screen does: read it, open its entry, hold it. */
  const show = async () => {
    const document: Document = await fetch();
    const entry = app.drafts.open(document);
    const leave = app.drafts.hold('doc');
    return { entry, leave, state: () => entry.autosave.getSnapshot() };
  };
  /** The app is killed: nothing more runs, and the writes not answered yet are lost. */
  const kill = async () => {
    const entry = app.drafts.get('doc');
    entry?.autosave.dispose();
    entry?.title.dispose();
    opened.splice(opened.indexOf(buffer), 1);
    await buffer.close();
  };
  void app.kept?.restore();
  if (open) await wait();
  return { app, show, fetch, kill, copy: app.copy! };
};

describe('the local buffer, from the editor', () => {
  it('writes every edit with its base, and deletes it once the server confirmed that exact text', async () => {
    const server = new FakeApi('A');
    const { show, copy } = await start(server);
    const { entry, state } = await show();
    expect(stored()).toBeUndefined();

    entry.autosave.edit('A and B');
    await copy.settled();
    expect(stored()).toEqual({ content: 'A and B', base: 'A', draftVersion: 1 });

    server.paused = true;
    await wait(debounceMs);
    expect(state().status).toBe('saving');
    // Typed during the request: written, never deleted by the answer for the text before it.
    entry.autosave.edit('A and B and C');
    // The answer for "A and B" arrives; the save of the text typed since waits.
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

  it('keeps only the newest text when the writer types faster than the disk', async () => {
    const server = new FakeApi('A');
    const { show, copy } = await start(server);
    const { entry } = await show();
    server.failing = offline;
    for (const text of ['A1', 'A12', 'A123', 'A1234']) entry.autosave.edit(text);
    await copy.settled();
    expect(stored()).toEqual({ content: 'A1234', base: 'A', draftVersion: 1 });
  });

  it('brings back a text typed offline after the app was killed, and saves it once the server is back', async () => {
    const server = new FakeApi('A');
    const first = await start(server);
    const { entry, state } = await first.show();
    server.failing = offline;
    entry.autosave.edit('Written in the train');
    await wait(debounceMs);
    expect(state().status).toBe('retrying');
    await first.copy.settled();
    await first.kill();

    // The app starts again, still offline: the document waits, and the text stays on the phone.
    const second = await start(server);
    await expect(second.fetch()).rejects.toBe(offline);
    expect(second.app.drafts.get('doc')).toBeUndefined();
    expect(stored()?.content).toBe('Written in the train');

    // The server is back: the text comes back as the local text, and is saved.
    server.failing = undefined;
    await second.app.kept?.restore();
    await wait();
    expect(server.draft).toMatchObject({ content: 'Written in the train', draftVersion: 2 });
    await second.copy.settled();
    expect(stored()).toBeUndefined();
    const { state: shown } = await second.show();
    expect(shown()).toMatchObject({ status: 'saved', content: 'Written in the train' });
  });

  it('shows the kept text, not the server’s, when the app starts online', async () => {
    const server = new FakeApi('A');
    const first = await start(server);
    const { entry } = await first.show();
    server.failing = offline;
    entry.autosave.edit('Kept');
    await first.copy.settled();
    await first.kill();

    server.failing = undefined;
    server.paused = true;
    const second = await start(server, { open: false });
    // The read of the document waits behind the restore: the screen never gets the server's text first.
    const reading = second.show();
    await wait();
    server.paused = false;
    server.release();
    const { state } = await reading;
    expect(state().content).toBe('Kept');
    await wait();
    expect(server.draft.content).toBe('Kept');
  });

  it('runs the usual conflict, on the right base, when the server moved while the app was dead', async () => {
    const server = new FakeApi('A');
    const first = await start(server);
    const { entry } = await first.show();
    server.failing = offline;
    entry.autosave.edit('Mine');
    await first.copy.settled();
    await first.kill();

    server.failing = undefined;
    server.otherDevice('Theirs');
    const second = await start(server);
    const { state } = await second.show();
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
    await second.copy.settled();
    expect(stored()?.content).toBe('Mine');

    await second.app.drafts.keepMine('doc');
    await wait();
    expect(server.revisions.map((revision) => revision.content)).toContain('Theirs');
    expect(server.draft.content).toBe('Mine');
    await second.copy.settled();
    expect(stored()).toBeUndefined();
  });

  it('sends the kept text on a newer counter when the server only saved a version of its base meanwhile', async () => {
    const server = new FakeApi('A');
    const first = await start(server);
    const { entry } = await first.show();
    server.failing = offline;
    entry.autosave.edit('A, then more');
    await first.copy.settled();
    await first.kill();

    server.failing = undefined;
    // The same text, a newer counter (as after a version saved elsewhere).
    server.document.draft = { ...server.draft, draftVersion: 2 };
    const second = await start(server);
    const { state } = await second.show();
    await wait(debounceMs);
    expect(state()).toMatchObject({ status: 'saved', content: 'A, then more' });
    expect(server.draft).toMatchObject({ content: 'A, then more', draftVersion: 3 });
  });

  it('drops a kept text the server already holds (its answer was lost), without a conflict', async () => {
    const server = new FakeApi('A');
    const first = await start(server);
    const { entry } = await first.show();
    server.paused = true;
    entry.autosave.edit('Sent');
    await wait(debounceMs);
    await first.copy.settled();
    // The server took the text, and the app was killed before the answer.
    server.paused = false;
    server.release();
    await first.kill();
    await wait();
    expect(server.draft.content).toBe('Sent');
    expect(stored()?.content).toBe('Sent');

    const second = await start(server);
    await second.copy.settled();
    expect(stored()).toBeUndefined();
    const { state } = await second.show();
    expect(state()).toMatchObject({ status: 'saved', content: 'Sent' });
  });

  it('tells the writer once when the buffer fails, and keeps the text on screen and retried', async () => {
    const server = new FakeApi('A');
    const broken = { broken: false };
    const { show, copy } = await start(server, { broken });
    const { entry, state } = await show();
    server.failing = offline;
    const heard = vi.fn();
    copy.subscribe(heard);

    broken.broken = true;
    entry.autosave.edit('Not kept');
    await copy.settled();
    expect(copy.failure()).toBe('failed');
    expect(heard).toHaveBeenCalledTimes(1);
    // Nothing in memory changes.
    expect(state()).toMatchObject({ status: 'unsaved', content: 'Not kept' });

    entry.autosave.edit('Not kept, still');
    await wait(debounceMs);
    await copy.settled();
    expect(state()).toMatchObject({ status: 'retrying', content: 'Not kept, still' });
    expect(heard).toHaveBeenCalledTimes(1);

    // The disk answers again: the next state change writes the newest text.
    broken.broken = false;
    await wait(1000);
    await copy.settled();
    expect(stored()?.content).toBe('Not kept, still');

    // The server is back: the text is saved, and the row goes.
    server.failing = undefined;
    await wait(2000);
    await copy.settled();
    expect(server.draft.content).toBe('Not kept, still');
    expect(stored()).toBeUndefined();

    copy.dismiss();
    expect(copy.dismissed()).toBe(true);
  });

  it('deletes the row whatever it holds once a text is confirmed after a failed write', async () => {
    const server = new FakeApi('A');
    const broken = { broken: false };
    const { show, copy } = await start(server, { broken });
    const { entry, state } = await show();
    entry.autosave.edit('Old');
    await copy.settled();
    expect(stored()?.content).toBe('Old');
    broken.broken = true;
    entry.autosave.edit('New');
    await copy.settled();
    broken.broken = false;
    await wait(debounceMs);
    await copy.settled();
    expect(state()).toMatchObject({ status: 'saved', content: 'New' });
    // The row held "Old", never confirmed: the server holds a later text, so it goes.
    expect(stored()).toBeUndefined();
  });

  it('opens documents as without a buffer when the buffer cannot be opened at all', async () => {
    const server = new FakeApi('A');
    const buffer = openLocalBuffer({
      open: () => Promise.reject(new Error('Cannot find native module ExpoSQLite')),
    });
    opened.push(buffer);
    const queryClient = new QueryClient();
    const report = { reportSuccess: () => undefined, reportError: () => undefined };
    const app = createAppDrafts(queryClient, { api: server, report, debounceMs, buffer });
    await app.kept?.restore();
    expect(app.copy?.failure()).toBe('unavailable');
    const document = await app.fetchDocument('doc');
    const entry = app.drafts.open(document);
    app.drafts.hold('doc');
    entry.autosave.edit('Still saved');
    await wait(debounceMs);
    expect(server.draft.content).toBe('Still saved');
  });

  it('opens documents without touching the buffer when it cannot be read, and restores its text at the next start', async () => {
    const server = new FakeApi('A');
    const first = await start(server);
    const { entry } = await first.show();
    server.failing = offline;
    entry.autosave.edit('Kept');
    await first.copy.settled();
    await first.kill();

    // The buffer cannot be read: the document opens on the server's text, and the kept text is left alone.
    server.failing = undefined;
    const second = await start(server, { broken: { broken: true } });
    const { entry: opened, state } = await second.show();
    expect(state().content).toBe('A');
    expect(second.copy.failure()).toBeDefined();
    opened.autosave.edit('New');
    await wait(debounceMs);
    await second.copy.settled();
    expect(server.draft.content).toBe('New');
    expect(stored()?.content).toBe('Kept');
    await second.kill();

    // The next start brings it back: the server moved meanwhile, so it is a conflict, never a replacement.
    const third = await start(server);
    const { state: restored } = await third.show();
    await wait(debounceMs);
    expect(restored()).toMatchObject({ status: 'conflict', content: 'Kept', server: { content: 'New' } });
    expect(server.draft.content).toBe('New');
  });

  it('removes the row of a document the writer deleted', async () => {
    const server = new FakeApi('A');
    const { show, copy, app } = await start(server);
    const { entry } = await show();
    server.failing = offline;
    entry.autosave.edit('Gone with the document');
    await copy.settled();
    expect(stored()).toBeDefined();
    app.drafts.discard('doc');
    await copy.settled();
    expect(stored()).toBeUndefined();
  });
});
