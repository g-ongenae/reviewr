import { NetworkError } from '@reviewr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedElsewhere, deleteAsSeen, textNotSaved, versionSaving } from './deleteAsSeen';
import { createDrafts } from './drafts';
import { FakeApi } from './fakeApi';

const debounceMs = 1000;

const setup = () => {
  const server = new FakeApi('morning');
  const drafts = createDrafts({
    api: server,
    report: { reportSuccess: vi.fn(), reportError: vi.fn() },
    onDraft: () => undefined,
    onDocument: () => undefined,
    debounceMs,
  });
  const entry = drafts.open(server.read());
  drafts.hold('doc');
  /** The head the screen shows: the document as this app last read it. */
  let shown = server.read().revision;
  const remove = (savingVersion = false) =>
    deleteAsSeen({
      autosave: entry.autosave,
      revision: () => shown,
      savingVersion,
      deleteDocument: async (seen) => server.deleteDocument('doc', seen),
    });
  const readAgain = () => {
    const read = server.read();
    shown = read.revision;
    drafts.read(read);
  };
  return { server, entry, remove, readAgain };
};

/** Settles a delete: undefined when it went through, its error otherwise. */
const outcome = async (removing: Promise<void>): Promise<unknown> =>
  removing.then(
    () => undefined,
    (error: unknown) => error,
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deleteAsSeen', () => {
  it('deletes the document when nothing moved since the screen read it', async () => {
    const { server, remove } = setup();

    expect(await outcome(remove())).toBeUndefined();
    expect(server.log).toEqual(['deleteDocument 1 1']);
    expect(server.gone).toBe(true);
  });

  it('deletes nothing when another device saved a draft since, and the text read again then deletes', async () => {
    const { server, entry, remove, readAgain } = setup();
    server.otherDevice('morning, then two pages');

    const error = await outcome(remove());
    expect(changedElsewhere(error)).toBe(true);
    expect(server.gone).toBe(false);

    // Read again with nothing typed here: the screen shows the other device's text, and the delete goes through.
    readAgain();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.autosave.getSnapshot().content).toBe('morning, then two pages');
    expect(await outcome(remove())).toBeUndefined();
    expect(server.log.at(-1)).toBe('deleteDocument 1 2');
    expect(server.gone).toBe(true);
  });

  it('deletes nothing when a version was saved elsewhere since, and keeps the text typed here', async () => {
    const { server, entry, remove, readAgain } = setup();
    server.otherVersion('evening');
    entry.autosave.edit('morning, mine');

    const error = await outcome(remove());
    expect(changedElsewhere(error)).toBe(true);
    expect(server.gone).toBe(false);
    // The text typed here was saved before the delete was sent, and stays on screen after the read.
    expect(server.draft.content).toBe('morning, mine');
    readAgain();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry.autosave.getSnapshot()).toMatchObject({ status: 'saved', content: 'morning, mine' });
  });

  it('never refuses itself: a text waiting for its save, or in flight, is saved first and the delete carries it', async () => {
    const { server, entry, remove } = setup();
    entry.autosave.edit('morning, last line');
    server.paused = true;

    const removing = outcome(remove());
    await vi.advanceTimersByTimeAsync(0);
    // The save goes first, without waiting for the debounce; the delete waits for its answer.
    server.release();
    await vi.advanceTimersByTimeAsync(0);
    server.paused = false;
    server.release();

    expect(await removing).toBeUndefined();
    expect(server.log).toEqual(['saveDraft morning, last line', 'deleteDocument 1 2']);
    expect(server.gone).toBe(true);
  });

  it('sends nothing when the text on screen could not be saved first', async () => {
    const { server, entry, remove } = setup();
    entry.autosave.edit('morning, unsent');
    server.failing = new NetworkError(new TypeError('Network request failed'));

    expect(await outcome(remove())).toBe(textNotSaved);
    expect(server.log).toEqual([]);
    expect(server.gone).toBe(false);
  });

  it('sends nothing while a version is being saved', async () => {
    const { server, remove } = setup();

    expect(await outcome(remove(true))).toBe(versionSaving);
    expect(server.log).toEqual([]);
  });

  it('tells a refused delete from other failures', () => {
    expect(changedElsewhere(textNotSaved)).toBe(false);
    expect(changedElsewhere(new NetworkError(new TypeError('x')))).toBe(false);
  });
});
