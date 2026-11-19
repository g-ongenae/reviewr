import { randomUUID as newId } from 'node:crypto';
import type { Document } from '@reviewr/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppDrafts } from './documentCache';
import type { DraftsApi } from './drafts';
import { FakeApi } from './fakeApi';
import { queryKeys } from './queryKeys';

const debounceMs = 1000;
const key = queryKeys.document('doc');

/** `through` stands between the app and the server, to hold an answer back. */
const setup = async (through: (server: FakeApi) => DraftsApi = (server) => server) => {
  const server = new FakeApi('A');
  const queryClient = new QueryClient();
  const report = { reportSuccess: () => undefined, reportError: () => undefined };
  const { drafts, fetchDocument } = createAppDrafts(queryClient, { api: through(server), report, debounceMs, newId });
  const fetch = () => queryClient.fetchQuery({ queryKey: key, queryFn: () => fetchDocument('doc'), staleTime: 0 });
  const entry = drafts.open(await fetch());
  const leave = drafts.hold('doc');
  const cached = () => queryClient.getQueryData<Document>(key);
  /** Starts a read the server answers now, whose answer arrives only at `server.releaseReads`. */
  const lateRead = async () => {
    server.lateReads = 1;
    const reading = fetch();
    await vi.advanceTimersByTimeAsync(0);
    return reading;
  };
  return { server, queryClient, drafts, fetchDocument, entry, leave, fetch, cached, lateRead };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAppDrafts: the cache never goes back', () => {
  it('a late read does not bring an older draft back, nor show it as saved once the document is opened again', async () => {
    const { server, drafts, entry, leave, cached, lateRead } = await setup();
    const reading = lateRead();
    entry.autosave.edit('B');
    await vi.advanceTimersByTimeAsync(debounceMs);
    expect(cached()?.draft).toMatchObject({ content: 'B', draftVersion: 2 });
    server.releaseReads();
    await reading;
    expect(cached()?.draft).toMatchObject({ content: 'B', draftVersion: 2 });

    leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.get('doc')).toBeUndefined();
    expect(drafts.open(cached()!).autosave.getSnapshot()).toMatchObject({ status: 'saved', content: 'B' });
  });

  it('a late read does not take back the revision of a version saved since', async () => {
    const { server, drafts, entry, cached, lateRead } = await setup();
    const reading = lateRead();
    entry.autosave.edit('B');
    await drafts.saveVersion('doc', 1);
    server.releaseReads();
    await reading;
    expect(cached()).toMatchObject({ revision: 2, content: 'B', draft: { content: 'B' } });
  });

  it('a version sent again after a lost answer shows the document as it is now, and a late read does not undo it', async () => {
    const { server, drafts, entry, cached, lateRead } = await setup();
    entry.autosave.edit('B');
    server.lostVersionAnswers = 1;
    await expect(drafts.saveVersion('doc', 1)).rejects.toThrow();
    const reading = lateRead();
    server.otherDevice('C');
    server.otherVersion('C');
    await drafts.saveVersion('doc', 1);
    server.releaseReads();
    await reading;
    expect(server.revisions.map((revision) => revision.content)).toEqual(['A', 'B', 'C']);
    expect(cached()).toMatchObject({ revision: 3, content: 'C', draft: { content: 'C', draftVersion: 3 } });
  });

  it('a late read does not take back the draft "Keep mine" saved', async () => {
    const { server, drafts, entry, cached, lateRead } = await setup();
    server.otherDevice('theirs');
    entry.autosave.edit('mine');
    await vi.advanceTimersByTimeAsync(debounceMs);
    const reading = lateRead();
    await drafts.keepMine('doc');
    await vi.advanceTimersByTimeAsync(0);
    server.releaseReads();
    await reading;
    expect(cached()).toMatchObject({ revision: 2, content: 'theirs', draft: { content: 'mine' } });
    expect(server.draft.content).toBe('mine');
  });

  it('a late read does not take back what was seen once the entry is dropped and the query collected', async () => {
    const { server, queryClient, drafts, fetchDocument, entry, leave, cached, fetch } = await setup();
    server.lateReads = 1;
    const reading = fetchDocument('doc');
    entry.autosave.edit('B');
    leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.get('doc')).toBeUndefined();
    queryClient.removeQueries({ queryKey: key });
    expect(cached()).toBeUndefined();
    server.releaseReads();
    expect((await reading).draft).toMatchObject({ content: 'B', draftVersion: 2 });
    // A newer answer still goes through.
    server.otherDevice('C');
    expect((await fetch()).draft).toMatchObject({ content: 'C', draftVersion: 3 });
  });

  it('a late read does not bring back the title a rename replaced since', async () => {
    const { server, drafts, entry, fetch, cached, lateRead } = await setup();
    const reading = lateRead();
    entry.title.edit('Renamed');
    entry.title.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(cached()?.title).toBe('Renamed');
    server.releaseReads();
    expect((await reading).title).toBe('Renamed');
    drafts.read(cached()!);
    expect(entry.title.getSnapshot()).toMatchObject({ status: 'saved', value: 'Renamed' });

    // A read that started after the rename was confirmed holds the server's title: another device's rename.
    await server.renameDocument('doc', 'Renamed elsewhere');
    expect((await fetch()).title).toBe('Renamed elsewhere');
    drafts.read(cached()!);
    expect(entry.title.getSnapshot()).toMatchObject({ status: 'saved', value: 'Renamed elsewhere' });
  });

  it('a late version answer does not undo a rename to no title', async () => {
    let release = () => {};
    const { drafts, entry, cached } = await setup((server) => ({
      getDocument: () => server.getDocument(),
      saveDraft: (id, input) => server.saveDraft(id, input),
      renameDocument: (id, title) => server.renameDocument(id, title),
      // The version is made at once, its answer arrives at `release`.
      createRevision: async (id, input) => {
        const answer = await server.createRevision(id, input);
        await new Promise<void>((resume) => {
          release = resume;
        });
        return answer;
      },
    }));
    entry.title.edit('Title');
    entry.title.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(cached()?.title).toBe('Title');

    entry.autosave.edit('B');
    const saving = drafts.saveVersion('doc', 1);
    await vi.advanceTimersByTimeAsync(0);
    entry.title.edit('');
    entry.title.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(cached()?.title).toBeNull();

    release();
    await saving;
    expect(cached()).toMatchObject({ revision: 2, content: 'B', title: null });
    drafts.read(cached()!);
    expect(entry.title.getSnapshot()).toMatchObject({ status: 'saved', value: '' });
  });
});
