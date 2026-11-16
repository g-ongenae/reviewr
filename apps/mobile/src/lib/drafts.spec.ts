import type { Document } from '@reviewr/shared';
import { NetworkError } from '@reviewr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafts, shownDocument } from './drafts';
import { FakeApi } from './fakeApi';

const debounceMs = 1000;

const setup = (content = 'base') => {
  const server = new FakeApi(content);
  const report = { reportSuccess: vi.fn(), reportError: vi.fn() };
  const documents: Document[] = [];
  const drafts = createDrafts({
    api: server,
    report,
    onDraft: () => undefined,
    onDocument: (document) => documents.push(document),
    debounceMs,
  });
  const entry = drafts.open(server.read());
  const leave = drafts.hold('doc');
  const state = () => entry.autosave.getSnapshot();
  return { server, report, documents, drafts, entry, leave, state };
};

/** Lets the timers run for `ms`, and every answer settle. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Puts the machine in a draft conflict: another device saved `theirs`, this one typed `mine`. */
const conflict = async (setupResult: ReturnType<typeof setup>, theirs = 'theirs', mine = 'mine') => {
  setupResult.server.otherDevice(theirs);
  setupResult.entry.autosave.edit(mine);
  await wait(debounceMs);
  expect(setupResult.state()).toMatchObject({ status: 'conflict', content: mine, server: { content: theirs } });
  setupResult.server.overwritten = [];
  setupResult.server.log = [];
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDrafts', () => {
  it('opens on the draft, or on the saved content of a document without one', () => {
    const { server, drafts } = setup();
    server.otherDevice('the draft');
    expect(drafts.open({ ...server.read(), id: 'other' }).autosave.getSnapshot().content).toBe('the draft');
    const { draft: _draft, ...withoutDraft } = { ...server.read(), id: 'old' };
    expect(drafts.open(withoutDraft).autosave.getSnapshot().content).toBe('base');
  });

  it('saves the text as a draft soon after the writer stops typing, without a revision', async () => {
    const { server, entry, state } = setup();
    entry.autosave.edit('base and more');
    expect(state().status).toBe('unsaved');
    await wait(debounceMs);
    expect(state()).toMatchObject({ status: 'saved', content: 'base and more' });
    expect(server.draft.content).toBe('base and more');
    expect(server.revisions).toHaveLength(1);
  });

  it('sends the text typed during a delayed answer right after it', async () => {
    const { server, entry, state } = setup();
    server.paused = true;
    entry.autosave.edit('one');
    await wait(debounceMs);
    expect(state().status).toBe('saving');
    entry.autosave.edit('one two');
    server.paused = false;
    server.release();
    await wait();
    expect(state()).toMatchObject({ status: 'saved', content: 'one two' });
    expect(server.log).toEqual(['saveDraft one', 'saveDraft one two']);
  });

  it('keeps the text and retries after a failed request', async () => {
    const { server, report, entry, state } = setup();
    server.failing = new NetworkError(new TypeError('offline'));
    entry.autosave.edit('written offline');
    await wait(debounceMs);
    expect(state()).toMatchObject({ status: 'retrying', content: 'written offline' });
    expect(report.reportError).toHaveBeenCalledWith(server.failing);
    server.failing = undefined;
    await wait(1000);
    expect(state().status).toBe('saved');
    expect(server.draft.content).toBe('written offline');
    expect(report.reportSuccess).toHaveBeenCalled();
  });

  it('saves the text typed just before leaving the screen, then forgets the document', async () => {
    const { server, drafts, entry, leave } = setup();
    server.paused = true;
    entry.autosave.edit('last words');
    entry.title.edit('A title');
    leave();
    await wait();
    // Sent at once, without waiting for the debounce.
    expect(entry.autosave.getSnapshot().status).toBe('saving');
    expect(drafts.get('doc')).toBe(entry);
    server.paused = false;
    server.release();
    await wait();
    expect(server.draft.content).toBe('last words');
    expect(server.document.title).toBe('A title');
    expect(drafts.get('doc')).toBeUndefined();
  });

  it('keeps a document a screen opens again while its text is being saved', async () => {
    const { server, drafts, entry, leave } = setup();
    server.paused = true;
    entry.autosave.edit('last words');
    leave();
    await wait();
    // Another screen opens the document; the answer arrives before that screen holds it.
    expect(drafts.open(server.read())).toBe(entry);
    server.paused = false;
    server.release();
    await wait();
    expect(drafts.get('doc')).toBe(entry);
    drafts.hold('doc');
    entry.autosave.edit('more words');
    await wait(debounceMs);
    expect(server.draft.content).toBe('more words');
  });

  it('keeps retrying a text left while the server is unreachable', async () => {
    const { server, drafts, entry, leave } = setup();
    server.failing = new NetworkError(new TypeError('offline'));
    entry.autosave.edit('left offline');
    leave();
    await wait(5000);
    expect(drafts.get('doc')).toBe(entry);
    server.failing = undefined;
    await wait(30_000);
    expect(server.draft.content).toBe('left offline');
    expect(drafts.get('doc')).toBeUndefined();
  });

  it('saves every document when the app goes to the background', async () => {
    const { server, drafts, entry } = setup();
    entry.autosave.edit('in background');
    drafts.flushAll();
    await wait();
    expect(server.draft.content).toBe('in background');
  });

  describe('draft conflict', () => {
    it('stops saving and keeps the text on screen', async () => {
      const context = setup();
      await conflict(context);
      context.entry.autosave.edit('mine, edited');
      await wait(10 * debounceMs);
      expect(context.state()).toMatchObject({ status: 'conflict', content: 'mine, edited' });
      expect(context.server.log).toEqual([]);
      expect(context.server.draft.content).toBe('theirs');
    });

    it('"Keep mine" keeps the other text as a version before any request overwrites it, then saves mine', async () => {
      const context = setup();
      const { server, drafts, state, documents } = context;
      await conflict(context);
      await drafts.keepMine('doc');
      await wait();
      expect(server.revisions.map((revision) => revision.content)).toEqual(['base', 'theirs']);
      expect(server.revisions[1]?.name).toMatch(/^Other device/);
      expect(server.overwritten).toEqual([{ text: 'theirs', kept: true }]);
      expect(server.log).toEqual(['getDocument', 'createRevision theirs', 'saveDraft mine']);
      expect(state()).toMatchObject({ status: 'saved', content: 'mine' });
      expect(server.draft.content).toBe('mine');
      expect(documents.at(-1)?.revision).toBe(2);
    });

    it('keeps the text and says why when "Keep mine" stops, and can be tried again', async () => {
      const context = setup();
      const { server, drafts, entry, state } = context;
      await conflict(context);
      server.failing = new NetworkError(new TypeError('offline'));
      await drafts.keepMine('doc');
      expect(entry.session.getSnapshot()).toMatchObject({ running: false, stop: { reason: 'failed' } });
      expect(state()).toMatchObject({ status: 'conflict', content: 'mine' });
      expect(server.overwritten).toEqual([]);

      server.failing = undefined;
      await drafts.keepMine('doc');
      await wait();
      expect(state()).toMatchObject({ status: 'saved', content: 'mine' });
      expect(server.overwritten).toEqual([{ text: 'theirs', kept: true }]);
    });

    it('stops when the other device writes again during "Keep mine", without overwriting its text', async () => {
      const context = setup();
      const { server, drafts, entry, state } = context;
      await conflict(context);
      server.paused = true;
      const keeping = drafts.keepMine('doc');
      server.otherDevice('theirs, again');
      server.paused = false;
      server.release();
      await keeping;
      expect(entry.session.getSnapshot().stop).toEqual({ reason: 'moved' });
      expect(state()).toMatchObject({ status: 'conflict', content: 'mine' });
      expect(server.overwritten.filter((item) => !item.kept)).toEqual([]);
    });
  });

  describe('failures that will not go away', () => {
    it('stops saving for good a document deleted elsewhere, and keeps the text', async () => {
      const { server, drafts, entry, leave, state } = setup();
      server.gone = true;
      entry.autosave.edit('written after the deletion');
      await wait(debounceMs);
      expect(state()).toMatchObject({ status: 'rejected', permanent: true, content: 'written after the deletion' });
      server.gone = false;
      entry.autosave.edit('more');
      leave();
      await wait(60_000);
      expect(server.log).toEqual([]);
      expect(drafts.get('doc')).toBe(entry);
      expect(drafts.canRestore('doc')).toBe(false);
    });

    it('shows the text of a document deleted elsewhere when the document cannot be read any more', async () => {
      const { server, drafts, entry, leave } = setup();
      server.gone = true;
      entry.autosave.edit('only here');
      await wait(debounceMs);
      leave();
      await wait();
      // The query was collected, and reading the document again fails: the app still shows the text it holds.
      const shown = shownDocument(drafts, 'doc', undefined);
      expect(shown?.id).toBe('doc');
      expect(drafts.open(shown!).autosave.getSnapshot()).toMatchObject({
        status: 'rejected',
        permanent: true,
        content: 'only here',
      });
    });

    it('shows nothing for a document the app holds no text for', async () => {
      const { drafts, leave } = setup();
      leave();
      await wait();
      expect(shownDocument(drafts, 'doc', undefined)).toBeUndefined();
    });

    it('keeps a refused text on screen, and saves it once changed', async () => {
      const { server, entry, state } = setup();
      entry.autosave.edit('a text far too large for this server');
      await wait(debounceMs);
      expect(state()).toMatchObject({ status: 'rejected', permanent: false });
      await wait(60_000);
      expect(server.log).toHaveLength(1);
      entry.autosave.edit('a short text');
      await wait(debounceMs);
      expect(state()).toMatchObject({ status: 'saved', content: 'a short text' });
    });
  });

  describe('saveVersion', () => {
    it('saves the draft, then makes it a version', async () => {
      const { server, drafts, entry, state } = setup();
      entry.autosave.edit('version two');
      const saved = await drafts.saveVersion('doc', 1);
      expect(saved?.revision).toBe(2);
      expect(server.revisions.at(-1)).toMatchObject({ revision: 2, content: 'version two', name: undefined });
      expect(state().status).toBe('saved');
    });

    it('is retried on the new head when the head moved elsewhere', async () => {
      const { server, drafts, entry } = setup();
      entry.autosave.edit('mine');
      await wait(debounceMs);
      server.otherVersion('a version from elsewhere');
      const saved = await drafts.saveVersion('doc', 1);
      expect(saved?.revision).toBe(3);
      expect(server.log.filter((request) => request.startsWith('createRevision'))).toHaveLength(2);
      expect(server.revisions.map((revision) => revision.content)).toEqual([
        'base',
        'a version from elsewhere',
        'mine',
      ]);
    });

    it('is a conflict when the draft moved elsewhere, and keeps the text', async () => {
      const { server, drafts, entry, state } = setup();
      entry.autosave.edit('mine');
      await wait(debounceMs);
      server.otherDevice('theirs');
      await expect(drafts.saveVersion('doc', 1)).rejects.toMatchObject({ status: 409 });
      expect(state()).toMatchObject({ status: 'conflict', content: 'mine', server: { content: 'theirs' } });
      expect(server.revisions).toHaveLength(1);
    });

    it('creates nothing when the draft could not be saved', async () => {
      const { server, drafts, entry } = setup();
      server.failing = new NetworkError(new TypeError('offline'));
      entry.autosave.edit('mine');
      expect(await drafts.saveVersion('doc', 1)).toBeUndefined();
      expect(server.revisions).toHaveLength(1);
    });
  });

  describe('restore', () => {
    it('puts the old version in the editor as an edit, saved as the draft without a revision', async () => {
      const { server, drafts, entry, state } = setup();
      entry.autosave.edit('today');
      await wait(debounceMs);
      expect(drafts.restore('doc', { title: 'Old title', content: 'an old text' })).toBe(true);
      expect(state()).toMatchObject({ status: 'unsaved', content: 'an old text' });
      expect(entry.title.getSnapshot().value).toBe('Old title');
      await wait(debounceMs);
      expect(server.draft.content).toBe('an old text');
      expect(server.document.title).toBe('Old title');
      expect(server.revisions).toHaveLength(1);
    });

    it('is refused while a conflict holds the text, which stays', async () => {
      const context = setup();
      await conflict(context);
      expect(context.drafts.canRestore('doc')).toBe(false);
      expect(context.drafts.restore('doc', { title: null, content: 'an old text' })).toBe(false);
      expect(context.state().content).toBe('mine');
    });
  });

  describe('a newer draft read from the server', () => {
    it('never replaces unsaved text', async () => {
      const { server, drafts, entry, state } = setup();
      entry.autosave.edit('mine, not sent yet');
      server.otherDevice('theirs');
      drafts.read(server.read());
      expect(state().content).toBe('mine, not sent yet');
      await wait(debounceMs);
      expect(state()).toMatchObject({ status: 'conflict', content: 'mine, not sent yet' });
      expect(server.draft.content).toBe('theirs');
    });

    it('replaces a saved text with nothing pending', () => {
      const { server, drafts, state } = setup();
      server.otherDevice('theirs');
      drafts.read(server.read());
      expect(state()).toMatchObject({ status: 'saved', content: 'theirs' });
    });
  });
});
