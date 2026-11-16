import type { Document } from '@reviewr/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppDrafts } from './documentCache';
import { FakeApi } from './fakeApi';
import { queryKeys } from './queryKeys';

const debounceMs = 1000;
const key = queryKeys.document('doc');

const setup = async () => {
  const server = new FakeApi('A');
  const queryClient = new QueryClient();
  const report = { reportSuccess: () => undefined, reportError: () => undefined };
  const { drafts, fetchDocument } = createAppDrafts(queryClient, { api: server, report, debounceMs });
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
});
