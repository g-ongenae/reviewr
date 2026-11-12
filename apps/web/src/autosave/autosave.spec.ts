import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, type Autosave, type AutosaveOptions, type Draft, type SaveResult } from './autosave';

interface PendingSave {
  draft: Draft;
  answer: (result: SaveResult) => Promise<void>;
  reject: (error: Error) => Promise<void>;
}

/**
 * A fake `save` whose requests stay pending until the test answers them, so responses can be delayed at will. It fails
 * the test if a second request starts before the first one settled.
 */
const fakeServer = () => {
  const calls: Draft[] = [];
  const pending: PendingSave[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const save = vi.fn((draft: Draft) => {
    calls.push(draft);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight > 1) throw new Error('A save was sent while another one was in flight');
    return new Promise<SaveResult>((resolve, reject) => {
      const done = () => {
        inFlight--;
        pending.shift();
      };
      // Answering lets the machine react (its continuation runs on the microtask queue) before the test goes on.
      pending.push({
        draft,
        answer: async (result) => {
          done();
          resolve(result);
          await vi.advanceTimersByTimeAsync(0);
        },
        reject: async (error) => {
          done();
          reject(error);
          await vi.advanceTimersByTimeAsync(0);
        },
      });
    });
  });

  /** The request in flight; fails the test if there is none. */
  const current = (): PendingSave => {
    const request = pending[0];
    if (request === undefined) throw new Error('No save in flight');
    return request;
  };

  return { save, calls, current, pendingCount: () => pending.length, maxInFlight: () => maxInFlight };
};

describe('createAutosave', () => {
  let server: ReturnType<typeof fakeServer>;
  let autosave: Autosave;

  const start = (options: Partial<AutosaveOptions> = {}) => {
    autosave = createAutosave({
      base: { content: 'Once', draftVersion: 1 },
      save: server.save,
      debounceMs: 500,
      ...options,
    });
    return autosave;
  };

  const status = () => autosave.getSnapshot().status;

  beforeEach(() => {
    vi.useFakeTimers();
    server = fakeServer();
  });

  afterEach(() => {
    autosave.dispose();
    // The invariant every scenario must keep.
    expect(server.maxInFlight()).toBeLessThanOrEqual(1);
    vi.useRealTimers();
  });

  it('starts saved, on the server draft it was opened on', () => {
    start();
    expect(autosave.getSnapshot()).toEqual({
      status: 'saved',
      content: 'Once',
      base: { content: 'Once', draftVersion: 1 },
    });
  });

  it('coalesces several edits into one request with the latest text, after the debounce', async () => {
    start();
    autosave.edit('Once u');
    await vi.advanceTimersByTimeAsync(300);
    autosave.edit('Once up');
    await vi.advanceTimersByTimeAsync(300);
    autosave.edit('Once upon');
    expect(status()).toBe('unsaved');
    expect(server.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(server.calls).toEqual([{ content: 'Once upon', draftVersion: 1 }]);
    expect(status()).toBe('saving');

    await server.current().answer({ kind: 'saved', draftVersion: 2 });
    expect(autosave.getSnapshot()).toEqual({
      status: 'saved',
      content: 'Once upon',
      base: { content: 'Once upon', draftVersion: 2 },
    });
    expect(server.calls).toHaveLength(1);
  });

  it('keeps text typed during a delayed request and sends it next, on the version that request returned', async () => {
    start();
    autosave.edit('Once upon');
    await vi.advanceTimersByTimeAsync(500);
    expect(server.pendingCount()).toBe(1);

    // The response is slow: the writer keeps typing, well past the debounce.
    autosave.edit('Once upon a');
    await vi.advanceTimersByTimeAsync(2000);
    autosave.edit('Once upon a tide');
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.calls).toHaveLength(1);
    expect(autosave.getSnapshot().content).toBe('Once upon a tide');
    expect(status()).toBe('saving');

    await server.current().answer({ kind: 'saved', draftVersion: 2 });
    expect(server.calls).toEqual([
      { content: 'Once upon', draftVersion: 1 },
      { content: 'Once upon a tide', draftVersion: 2 },
    ]);
    expect(status()).toBe('saving');

    await server.current().answer({ kind: 'saved', draftVersion: 3 });
    expect(autosave.getSnapshot()).toEqual({
      status: 'saved',
      content: 'Once upon a tide',
      base: { content: 'Once upon a tide', draftVersion: 3 },
    });
  });

  it('sends nothing when the text is back to the saved draft', async () => {
    start();
    autosave.edit('Once upon');
    autosave.edit('Once');
    expect(status()).toBe('saved');
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.calls).toEqual([]);
  });

  describe('flush', () => {
    it('saves right away during the debounce, and settles once saved', async () => {
      start();
      autosave.edit('Once upon');
      const flushed = autosave.flush();
      expect(server.calls).toEqual([{ content: 'Once upon', draftVersion: 1 }]);

      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      await expect(flushed).resolves.toBe('saved');
      // The debounce was cancelled: no second request.
      await vi.advanceTimersByTimeAsync(5000);
      expect(server.calls).toHaveLength(1);
    });

    it('settles at once when there is nothing to save', async () => {
      start();
      await expect(autosave.flush()).resolves.toBe('saved');
      expect(server.calls).toEqual([]);
    });

    it('during a request, waits for it and for the text typed meanwhile', async () => {
      start();
      autosave.edit('Once upon');
      await vi.advanceTimersByTimeAsync(500);
      autosave.edit('Once upon a tide');
      let outcome: string | undefined;
      void autosave.flush().then((value) => (outcome = value));

      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      expect(outcome).toBeUndefined();
      expect(server.calls.at(-1)).toEqual({ content: 'Once upon a tide', draftVersion: 2 });

      await server.current().answer({ kind: 'saved', draftVersion: 3 });
      expect(outcome).toBe('saved');
    });

    it('does not wait for text typed after it was called', async () => {
      start();
      autosave.edit('Once upon');
      let outcome: string | undefined;
      void autosave.flush().then((value) => (outcome = value));
      autosave.edit('Once upon a tide');

      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      expect(outcome).toBe('saved');
      expect(server.calls.at(-1)).toEqual({ content: 'Once upon a tide', draftVersion: 2 });
      await server.current().answer({ kind: 'saved', draftVersion: 3 });
    });

    it('settles as failed when the request fails, keeping the text', async () => {
      start();
      autosave.edit('Once upon');
      const flushed = autosave.flush();
      await server.current().reject(new TypeError('Failed to fetch'));
      await expect(flushed).resolves.toBe('failed');
      expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', content: 'Once upon' });
    });
  });

  describe('failures', () => {
    it('keeps the text and retries with a backoff, then saves the latest text', async () => {
      start({ retryDelayMs: (attempt) => attempt * 1000 });
      autosave.edit('Once upon');
      await vi.advanceTimersByTimeAsync(500);
      const error = new Error('502');
      await server.current().answer({ kind: 'failed', error });
      expect(autosave.getSnapshot()).toEqual({
        status: 'retrying',
        error,
        attempt: 1,
        content: 'Once upon',
        base: { content: 'Once', draftVersion: 1 },
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(server.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.calls).toHaveLength(2);
      await server.current().reject(new TypeError('Failed to fetch'));
      expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', attempt: 2 });

      // Typed while waiting for the second retry (2s): the new edit retries after the debounce instead.
      autosave.edit('Once upon a tide');
      await vi.advanceTimersByTimeAsync(500);
      expect(server.calls.at(-1)).toEqual({ content: 'Once upon a tide', draftVersion: 1 });
      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      expect(autosave.getSnapshot()).toEqual({
        status: 'saved',
        content: 'Once upon a tide',
        base: { content: 'Once upon a tide', draftVersion: 2 },
      });
    });

    it('lets a flush retry before the backoff', async () => {
      start({ retryDelayMs: () => 60_000 });
      autosave.edit('Once upon');
      await vi.advanceTimersByTimeAsync(500);
      await server.current().answer({ kind: 'failed', error: new Error('503') });

      const flushed = autosave.flush();
      expect(server.calls).toHaveLength(2);
      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      await expect(flushed).resolves.toBe('saved');
      expect(status()).toBe('saved');
    });

    it('treats a save that throws as a failure, and edit never throws', async () => {
      const save = vi.fn((): Promise<SaveResult> => {
        throw new Error('boom');
      });
      start({ save });
      expect(() => autosave.edit('Once upon')).not.toThrow();
      await vi.advanceTimersByTimeAsync(500);
      expect(save).toHaveBeenCalledTimes(1);
      expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', content: 'Once upon' });
    });
  });

  describe('a permanent failure', () => {
    it('stops sending for good, keeps the text and settles flushes as rejected', async () => {
      start({ retryDelayMs: () => 1000 });
      autosave.edit('Once upon');
      const flushed = autosave.flush();
      const error = new Error('404');
      await server.current().answer({ kind: 'rejected', error, permanent: true });
      await expect(flushed).resolves.toBe('rejected');
      expect(autosave.getSnapshot()).toEqual({
        status: 'rejected',
        error,
        permanent: true,
        content: 'Once upon',
        base: { content: 'Once', draftVersion: 1 },
      });

      // Neither the backoff, nor an edit, nor a flush sends anything again.
      autosave.edit('Once upon a tide');
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(autosave.flush()).resolves.toBe('rejected');
      expect(server.calls).toHaveLength(1);
      expect(autosave.getSnapshot()).toMatchObject({ status: 'rejected', content: 'Once upon a tide' });
    });

    it('also stops a retry in progress, and text typed during the request stays unsent', async () => {
      start({ retryDelayMs: () => 1000 });
      autosave.edit('Once upon');
      await vi.advanceTimersByTimeAsync(500);
      await server.current().answer({ kind: 'failed', error: new Error('503') });
      await vi.advanceTimersByTimeAsync(1000);
      autosave.edit('Once upon a tide');
      await server.current().answer({ kind: 'rejected', error: new Error('404'), permanent: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.calls).toHaveLength(2);
      expect(autosave.getSnapshot()).toMatchObject({ status: 'rejected', content: 'Once upon a tide' });
    });
  });

  describe('a refused text', () => {
    it('is not sent again, but a changed text is', async () => {
      start({ retryDelayMs: () => 1000 });
      autosave.edit('Once upon a very long tide');
      await vi.advanceTimersByTimeAsync(500);
      await server.current().answer({ kind: 'rejected', error: new Error('413'), permanent: false });
      expect(autosave.getSnapshot()).toMatchObject({ status: 'rejected', permanent: false });

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(autosave.flush()).resolves.toBe('rejected');
      expect(server.calls).toHaveLength(1);

      autosave.edit('Once upon a tide');
      expect(status()).toBe('unsaved');
      await vi.advanceTimersByTimeAsync(500);
      expect(server.calls.at(-1)).toEqual({ content: 'Once upon a tide', draftVersion: 1 });
      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      expect(status()).toBe('saved');
    });

    it('lets a flush send text typed during the refused request', async () => {
      start();
      autosave.edit('Once upon a very long tide');
      await vi.advanceTimersByTimeAsync(500);
      autosave.edit('Once upon a tide');
      await server.current().answer({ kind: 'rejected', error: new Error('400'), permanent: false });
      const flushed = autosave.flush();
      expect(server.calls.at(-1)).toEqual({ content: 'Once upon a tide', draftVersion: 1 });
      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      await expect(flushed).resolves.toBe('saved');
    });
  });

  describe('refresh', () => {
    it('adopts a newer confirmed draft when there are no local edits', () => {
      start();
      autosave.refresh({ content: 'Once upon a time', draftVersion: 4 });
      expect(autosave.getSnapshot()).toEqual({
        status: 'saved',
        content: 'Once upon a time',
        base: { content: 'Once upon a time', draftVersion: 4 },
      });
    });

    it('ignores an older or equal version', () => {
      start({ base: { content: 'Once', draftVersion: 5 } });
      autosave.refresh({ content: 'Stale', draftVersion: 4 });
      autosave.refresh({ content: 'Stale', draftVersion: 5 });
      expect(autosave.getSnapshot().content).toBe('Once');
    });

    it('keeps local edits over a different draft, and their save meets the conflict', async () => {
      start();
      autosave.edit('Once upon a tide');
      autosave.refresh({ content: 'Once upon a time', draftVersion: 4 });
      expect(autosave.getSnapshot()).toMatchObject({ status: 'unsaved', content: 'Once upon a tide' });
      await vi.advanceTimersByTimeAsync(500);
      expect(server.calls).toEqual([{ content: 'Once upon a tide', draftVersion: 1 }]);
    });

    it('takes a counter bump of the base and keeps local edits, sent on the new version', async () => {
      start();
      autosave.edit('Once upon a tide');
      autosave.refresh({ content: 'Once', draftVersion: 2 });
      expect(autosave.getSnapshot()).toMatchObject({ status: 'unsaved', content: 'Once upon a tide' });
      await vi.advanceTimersByTimeAsync(500);
      expect(server.calls).toEqual([{ content: 'Once upon a tide', draftVersion: 2 }]);
    });

    it('is ignored while a request is in flight or after a failure', async () => {
      start({ retryDelayMs: () => 1000 });
      autosave.edit('Once upon');
      await vi.advanceTimersByTimeAsync(500);
      autosave.refresh({ content: 'Other', draftVersion: 9 });
      await server.current().answer({ kind: 'failed', error: new Error('503') });
      autosave.refresh({ content: 'Other', draftVersion: 9 });
      expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', content: 'Once upon' });
    });
  });

  describe('a failed write whose outcome is unknown', () => {
    // The server may have committed B as version 2 and the response was lost: a revert to A is not saved yet.
    const startOnA = () => start({ base: { content: 'A', draftVersion: 1 }, retryDelayMs: () => 1000 });
    const theirs: Draft = { content: 'B', draftVersion: 2 };

    it('still sends a revert typed during the request, and the stale version gets a conflict', async () => {
      startOnA();
      autosave.edit('B');
      await vi.advanceTimersByTimeAsync(500);
      autosave.edit('A');
      await server.current().reject(new TypeError('Failed to fetch'));
      expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', content: 'A' });

      await vi.advanceTimersByTimeAsync(1000);
      expect(server.calls.at(-1)).toEqual({ content: 'A', draftVersion: 1 });
      expect(status()).toBe('retrying');
      await server.current().answer({ kind: 'conflict', server: theirs });
      expect(autosave.getSnapshot()).toMatchObject({ status: 'conflict', content: 'A', server: theirs });
    });

    it('does not report a revert typed after the failure as saved, and flush sends it', async () => {
      startOnA();
      autosave.edit('B');
      await vi.advanceTimersByTimeAsync(500);
      await server.current().reject(new TypeError('Failed to fetch'));

      autosave.edit('A');
      expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', content: 'A' });
      let outcome: string | undefined;
      void autosave.flush().then((value) => (outcome = value));
      expect(server.calls.at(-1)).toEqual({ content: 'A', draftVersion: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBeUndefined();

      await server.current().answer({ kind: 'conflict', server: theirs });
      expect(outcome).toBe('conflict');
      expect(autosave.getSnapshot()).toMatchObject({ status: 'conflict', content: 'A' });
    });

    it('is saved once the revert is confirmed, when the failed write had not landed', async () => {
      startOnA();
      autosave.edit('B');
      await vi.advanceTimersByTimeAsync(500);
      await server.current().reject(new TypeError('Failed to fetch'));
      autosave.edit('A');
      const flushed = autosave.flush();
      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      await expect(flushed).resolves.toBe('saved');
      expect(autosave.getSnapshot()).toEqual({
        status: 'saved',
        content: 'A',
        base: { content: 'A', draftVersion: 2 },
      });
    });
  });

  describe('conflicts', () => {
    const theirs: Draft = { content: 'Once upon a time', draftVersion: 5 };

    it('stops sending, keeps base, local text and the server draft, until resolved', async () => {
      start();
      autosave.edit('Once upon a tide');
      await vi.advanceTimersByTimeAsync(500);
      autosave.edit('Once upon a tide, again');
      await server.current().answer({ kind: 'conflict', server: theirs });

      expect(autosave.getSnapshot()).toEqual({
        status: 'conflict',
        content: 'Once upon a tide, again',
        base: { content: 'Once', draftVersion: 1 },
        server: theirs,
      });
      // Edits are kept but not sent, and a flush does not wait.
      autosave.edit('Once upon a tide, again and again');
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(autosave.flush()).resolves.toBe('conflict');
      expect(server.calls).toHaveLength(1);
      expect(autosave.getSnapshot()).toMatchObject({
        status: 'conflict',
        content: 'Once upon a tide, again and again',
      });

      autosave.resolve('Once upon a time, a tide', theirs);
      expect(server.calls.at(-1)).toEqual({ content: 'Once upon a time, a tide', draftVersion: 5 });
      await server.current().answer({ kind: 'saved', draftVersion: 6 });
      expect(autosave.getSnapshot()).toEqual({
        status: 'saved',
        content: 'Once upon a time, a tide',
        base: { content: 'Once upon a time, a tide', draftVersion: 6 },
      });
    });

    it('sends nothing when resolved by taking the server draft', async () => {
      start();
      autosave.edit('Once upon a tide');
      await vi.advanceTimersByTimeAsync(500);
      await server.current().answer({ kind: 'conflict', server: theirs });

      autosave.resolve(theirs.content, theirs);
      expect(autosave.getSnapshot()).toEqual({ status: 'saved', content: theirs.content, base: theirs });
      expect(server.calls).toHaveLength(1);
    });

    it('resolves on the confirmed draft it is given, not on the text of the conflict', async () => {
      // The conflict carried B at 7; the writer edits back to B; another device moves the draft to C at 8.
      start();
      autosave.edit('Once upon a tide');
      await vi.advanceTimersByTimeAsync(500);
      const b: Draft = { content: 'B', draftVersion: 7 };
      await server.current().answer({ kind: 'conflict', server: b });
      autosave.edit('B');

      autosave.resolve('B', { content: 'C', draftVersion: 8 });
      expect(server.calls.at(-1)).toEqual({ content: 'B', draftVersion: 8 });
      expect(status()).toBe('saving');
      await server.current().answer({ kind: 'saved', draftVersion: 9 });
      expect(autosave.getSnapshot()).toEqual({
        status: 'saved',
        content: 'B',
        base: { content: 'B', draftVersion: 9 },
      });
    });

    it('is no conflict when only the counter of the base moved: the text is sent again on it', async () => {
      start();
      autosave.edit('Once upon a tide');
      await vi.advanceTimersByTimeAsync(500);
      await server.current().answer({ kind: 'conflict', server: { content: 'Once', draftVersion: 2 } });
      expect(server.calls.at(-1)).toEqual({ content: 'Once upon a tide', draftVersion: 2 });
      await server.current().answer({ kind: 'saved', draftVersion: 3 });
      expect(status()).toBe('saved');
    });

    it('settles a pending flush as conflict', async () => {
      start();
      autosave.edit('Once upon a tide');
      const flushed = autosave.flush();
      await server.current().answer({ kind: 'conflict', server: theirs });
      await expect(flushed).resolves.toBe('conflict');
    });
  });

  describe('dispose', () => {
    it('during a request, ignores the response and sends nothing more', async () => {
      start();
      const listener = vi.fn();
      autosave.subscribe(listener);
      autosave.edit('Once upon');
      await vi.advanceTimersByTimeAsync(500);
      autosave.edit('Once upon a tide');
      const flushed = autosave.flush();
      listener.mockClear();

      autosave.dispose();
      await expect(flushed).resolves.toBe('disposed');
      await server.current().answer({ kind: 'saved', draftVersion: 2 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.calls).toHaveLength(1);
      expect(listener).not.toHaveBeenCalled();
      await expect(autosave.flush()).resolves.toBe('disposed');
    });

    it('stops notifying when a listener disposes the machine', () => {
      start();
      const later = vi.fn();
      autosave.subscribe(() => autosave.dispose());
      autosave.subscribe(later);
      autosave.edit('Once upon');
      expect(later).not.toHaveBeenCalled();
    });

    it('cancels a pending debounce', async () => {
      start();
      autosave.edit('Once upon');
      autosave.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.calls).toEqual([]);
    });
  });

  describe('subscribe', () => {
    it('notifies on changes and keeps the same snapshot in between', async () => {
      start();
      const listener = vi.fn();
      const unsubscribe = autosave.subscribe(listener);
      const first = autosave.getSnapshot();
      expect(autosave.getSnapshot()).toBe(first);

      autosave.edit('Once upon');
      expect(listener).toHaveBeenCalledTimes(1);
      const unsaved = autosave.getSnapshot();
      expect(unsaved).not.toBe(first);

      // The same text again changes nothing: same snapshot, nobody notified.
      autosave.edit('Once upon');
      expect(autosave.getSnapshot()).toBe(unsaved);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      await vi.advanceTimersByTimeAsync(500);
      expect(status()).toBe('saving');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
