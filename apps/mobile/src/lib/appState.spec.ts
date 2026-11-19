import { randomUUID as newId } from 'node:crypto';
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onAppStateChange } from './appState';
import { createDrafts } from './drafts';
import { FakeApi } from './fakeApi';

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('onAppStateChange', () => {
  it('reads the document shown again when the app becomes active, and saves every document when it leaves', async () => {
    vi.useFakeTimers();
    const server = new FakeApi('A');
    const queryClient = new QueryClient();
    // As `QueryClientProvider` does: the client listens to the focus manager.
    queryClient.mount();
    const report = { reportSuccess: () => undefined, reportError: () => undefined };
    const drafts = createDrafts({ api: server, report, onDraft: () => undefined, onDocument: () => undefined, newId });
    const change = onAppStateChange(drafts);
    // The editor's query, as `useQuery` observes it.
    const observer = new QueryObserver(queryClient, {
      queryKey: ['documents', 'doc'],
      queryFn: () => server.getDocument(),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.log).toEqual(['getDocument']);

    drafts.open(server.read()).autosave.edit('typed before leaving');
    change('background');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.draft.content).toBe('typed before leaving');

    server.otherDevice('written elsewhere meanwhile');
    change('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.log.filter((request) => request === 'getDocument')).toHaveLength(2);
    expect(observer.getCurrentResult().data?.draft?.content).toBe('written elsewhere meanwhile');
    unsubscribe();
    queryClient.unmount();
  });
});
