import { DeleteRefused } from '@reviewr/autosave';
import type { Document } from '@reviewr/shared';
import { conflictOf } from '@reviewr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafts } from './drafts';
import { FakeApi } from './fakeApi';

const debounceMs = 1000;

/** The editor screen's wiring: `captureDelete` when the writer confirms, then `deleteAsSeen` in the mutation. */
const setup = () => {
  const server = new FakeApi('morning');
  const drafts = createDrafts({
    api: server,
    report: { reportSuccess: vi.fn(), reportError: vi.fn() },
    onDraft: () => undefined,
    onDocument: () => undefined,
    debounceMs,
  });
  /** What the screen rendered. */
  const shown: Document = server.read();
  const entry = drafts.open(shown);
  drafts.hold('doc');
  const confirm = () => drafts.captureDelete('doc', shown.revision);
  const send = async (capture: ReturnType<typeof confirm>): Promise<unknown> =>
    drafts.deleteAsSeen('doc', capture, async (seen) => server.deleteDocument('doc', seen)).then(
      () => undefined,
      (error: unknown) => error,
    );
  return { server, drafts, entry, shown, confirm, send };
};

const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const reasonOf = (error: unknown) => (error instanceof DeleteRefused ? error.reason : undefined);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deleting from the editor screen', () => {
  it('deletes with the head the screen showed and the confirmed draft', async () => {
    const { server, confirm, send } = setup();

    expect(await send(confirm())).toBeUndefined();
    expect(server.log).toEqual(['deleteDocument 1 1']);
    expect(server.gone).toBe(true);
  });

  it('carries the head the screen showed even when a newer one was read since: the server refuses', async () => {
    const { server, drafts, confirm, send } = setup();
    server.otherVersion('evening');
    // A read brings the new head to the entry, but the screen has not rendered it yet.
    drafts.read(server.read());

    const error = await send(confirm());
    expect(conflictOf(error)).toMatchObject({ code: 'document_changed', revision: 2 });
    expect(server.gone).toBe(false);
  });

  it('saves the text on screen first, and carries the version the server gave it', async () => {
    const { server, entry, confirm, send } = setup();
    entry.autosave.edit('morning, mine');
    server.paused = true;

    const deleting = send(confirm());
    await wait();
    server.paused = false;
    server.release();
    await wait();

    expect(await deleting).toBeUndefined();
    expect(server.log).toEqual(['saveDraft morning, mine', 'deleteDocument 1 2']);
  });

  it('sends nothing while a version is being saved', async () => {
    const { server, entry, drafts, confirm, send } = setup();
    entry.autosave.edit('morning, two');
    server.paused = true;
    const saving = drafts.saveVersion('doc', 1);
    await wait();

    expect(reasonOf(await send(confirm()))).toBe('busy');
    server.paused = false;
    server.release();
    await saving;
    expect(server.log.some((request) => request.startsWith('deleteDocument'))).toBe(false);
  });

  it('sends nothing while a restore is running', async () => {
    const { server, entry, drafts, shown, confirm, send } = setup();
    entry.autosave.edit('morning, two');
    await wait(debounceMs);
    server.paused = true;
    // The text on screen is in no version: the restore first keeps it as one, and waits for the server.
    const restoring = drafts.restore('doc', { title: null, content: 'old' }, shown);
    await wait();

    expect(reasonOf(await send(confirm()))).toBe('busy');
    server.paused = false;
    server.release();
    await restoring;
  });

  it('sends nothing in a conflict, nor while "Keep mine" runs', async () => {
    const { server, entry, drafts, confirm, send } = setup();
    server.otherDevice('theirs');
    entry.autosave.edit('mine');
    await wait(debounceMs);
    expect(reasonOf(await send(confirm()))).toBe('conflict');

    server.paused = true;
    const keeping = drafts.keepMine('doc');
    await wait();
    expect(reasonOf(await send(confirm()))).toBe('busy');
    server.paused = false;
    server.release();
    await keeping;
    expect(server.log.some((request) => request.startsWith('deleteDocument'))).toBe(false);
  });

  it('starts no restore while the delete waits for its answer', async () => {
    const { server, drafts, confirm, send } = setup();
    server.paused = true;
    const deleting = send(confirm());
    await wait();

    expect(drafts.canRestore('doc')).toBe(false);
    server.paused = false;
    server.release();
    await deleting;
  });

  it('keeps the entry when the delete cannot reach the server', async () => {
    const { server, drafts, confirm, send } = setup();
    server.failing = new Error('Network request failed');

    expect(await send(confirm())).toEqual(server.failing);
    expect(drafts.canRestore('doc')).toBe(true);
    expect(drafts.get('doc')?.autosave.getSnapshot()).toMatchObject({ status: 'saved', content: 'morning' });
  });
});
