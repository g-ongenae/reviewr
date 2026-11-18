import { conflictOf } from '@reviewr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askToDelete, type SeenPair } from './askToDelete';
import { createDrafts } from './drafts';
import { FakeApi } from './fakeApi';

const debounceMs = 1000;

/** The editor screen around `askToDelete`: the drafts registry, the fake server, an alert held open. */
const setup = () => {
  const server = new FakeApi('morning');
  const drafts = createDrafts({
    api: server,
    report: { reportSuccess: vi.fn(), reportError: vi.fn() },
    onDraft: () => undefined,
    onDocument: () => undefined,
    debounceMs,
  });
  const shown = server.read();
  const { autosave } = drafts.open(shown);
  drafts.hold('doc');
  let pressDelete: (() => void) | undefined;
  let refusal: string | undefined;
  let sent: Promise<unknown> | undefined;
  /** Taps "Delete" on a screen rendered with the machine's state of now; the alert stays open. */
  const tapDelete = (writing = false) =>
    askToDelete(
      { state: autosave.getSnapshot(), revision: shown.revision, writing },
      (onConfirm) => {
        pressDelete = onConfirm;
      },
      (seen: SeenPair) => {
        sent = server.deleteDocument('doc', seen).then(
          () => undefined,
          (error: unknown) => error,
        );
      },
      (message) => {
        refusal = message;
      },
    );
  return {
    server,
    drafts,
    autosave,
    tapDelete,
    pressDelete: () => pressDelete?.(),
    refusal: () => refusal,
    sent: () => sent,
  };
};

describe('askToDelete on the editor screen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes with the pair the screen showed', async () => {
    const { server, tapDelete, pressDelete, sent } = setup();
    tapDelete();
    pressDelete();

    expect(await sent()).toBeUndefined();
    expect(server.log).toEqual(['deleteDocument 1 1']);
    expect(server.gone).toBe(true);
  });

  it('sends the pair taken before the alert opened, even after a read the machine adopted meanwhile', async () => {
    const { server, drafts, autosave, tapDelete, pressDelete, sent } = setup();
    tapDelete();
    // While the alert is open, another device saves a draft and this app reads it.
    server.otherDevice('morning, then two pages');
    drafts.read(server.read());
    expect(autosave.getSnapshot().base.draftVersion).toBe(2);
    pressDelete();

    expect(conflictOf(await sent())?.code).toBe('document_changed');
    expect(server.log).toEqual(['deleteDocument 1 1']);
    expect(server.gone).toBe(false);
  });

  it('asks nothing while text is not saved yet, in a conflict, or while another write runs', async () => {
    const unsaved = setup();
    unsaved.autosave.edit('morning, mine');
    unsaved.tapDelete();
    expect(unsaved.refusal()).toBe('Not deleted: your text is not saved yet. Delete once it is saved.');

    const conflict = setup();
    conflict.server.otherDevice('theirs');
    conflict.autosave.edit('mine');
    await vi.advanceTimersByTimeAsync(debounceMs);
    conflict.tapDelete();
    expect(conflict.refusal()).toMatch(/^Not deleted: this document was changed on another device/);

    const writing = setup();
    writing.tapDelete(true);
    expect(writing.refusal()).toMatch(/^Not deleted: a version, a merge or a restore is in progress/);

    for (const screen of [unsaved, conflict, writing]) {
      expect(screen.sent()).toBeUndefined();
      expect(screen.server.log.filter((request) => request.startsWith('deleteDocument'))).toEqual([]);
    }
  });
});
