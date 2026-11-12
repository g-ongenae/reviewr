/**
 * The autosave state machine: it sends the text being written as the document's draft, one request at a time.
 *
 * It is framework-free on purpose. It knows nothing about HTTP, React or storage: it is given a `save` function and
 * timers, and exposes `edit`, `flush`, `resolve`, `dispose` and an observable state.
 */

/** A draft as the server knows it: its content and the counter used to detect concurrent writes. */
export interface Draft {
  content: string;
  draftVersion: number;
}

/** What a `save` call can answer. A rejected promise counts as `failed`. */
export type SaveResult =
  /** The draft was saved; `draftVersion` is the server's new version, the base of the next save. */
  | { kind: 'saved'; draftVersion: number }
  /** The `draftVersion` sent was stale: someone else saved meanwhile. `server` is the server's current draft. */
  | { kind: 'conflict'; server: Draft }
  /** The request failed (network error, 5xx…). The text is kept and sent again later. */
  | { kind: 'failed'; error: unknown }
  /**
   * The server refused this draft: sending it again cannot help. When `permanent` (the document was deleted), nothing is
   * ever sent again; otherwise (too large, invalid) a changed text is sent, never the refused one.
   */
  | { kind: 'rejected'; error: unknown; permanent: boolean };

/**
 * Saves `content` as the draft, based on `draftVersion` (the version the content was written from). It is never
 * called again before the previous call settles.
 */
export type SaveDraft = (draft: Draft) => Promise<SaveResult>;

/** The timers the machine runs on. Defaults to the global `setTimeout`/`clearTimeout`. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutosaveOptions {
  /** The server's draft the editor was opened on. */
  base: Draft;
  save: SaveDraft;
  /** How long to wait after the last edit before saving, in milliseconds. Defaults to 1000. */
  debounceMs?: number;
  /** Delay before the `attempt`-th retry after a failure (1 for the first), in milliseconds. Defaults to 1s, 2s, 4s… up to 30s. */
  retryDelayMs?: (attempt: number) => number;
  timers?: Timers;
}

interface CommonState {
  /** The latest text written locally, saved or not. */
  content: string;
  /** The last draft the server confirmed: what the local text is based on. */
  base: Draft;
}

/**
 * What the UI shows, in order of precedence:
 *
 * - `rejected`: the server refused the draft. The text is kept. Nothing is sent again if `permanent`; otherwise the
 *   refused text is never sent again, and a changed text (even one typed while the refused request was in flight) is
 *   saved as usual.
 * - `conflict`: the server's draft moved under the local text. Nothing is sent until `resolve` is called. A server
 *   draft that is still the local text's `base` with a newer counter (a version save moved it) is no conflict: the
 *   local text is sent again on that counter.
 * - `retrying`: the last request failed. The text is kept and sent again after a backoff (a retry may be in flight).
 *   It stays so even if the text is edited back to `base`: the failed write may have reached the server.
 * - `saving`: a request is in flight. Text typed meanwhile is sent right after it.
 * - `unsaved`: the text differs from the server's draft, and a save is scheduled.
 * - `saved`: the server's draft is the local text.
 */
export type AutosaveState = CommonState &
  (
    | { status: 'saved' }
    | { status: 'unsaved' }
    | { status: 'saving' }
    | { status: 'retrying'; error: unknown; attempt: number }
    | { status: 'conflict'; server: Draft }
    | { status: 'rejected'; error: unknown; permanent: boolean }
  );

/** How a `flush` ended. */
export type FlushOutcome = 'saved' | 'failed' | 'conflict' | 'rejected' | 'disposed';

export interface Autosave {
  /** Records the latest text and schedules a save. Never throws. */
  edit(content: string): void;
  /**
   * Saves now, without waiting for the debounce. Settles when everything edited up to this call is saved, or when a
   * request fails, hits a conflict or is rejected, or the machine is disposed. Never rejects.
   */
  flush(): Promise<FlushOutcome>;
  /**
   * Leaves the conflict state with the reconciled `content`, based on `confirmed`: a draft the server confirmed, content
   * and version together (from the conflict, or read since), and saves it unless it is that draft. Ignored outside the
   * conflict state.
   */
  resolve(content: string, confirmed: Draft): void;
  /**
   * Tells the machine about a draft the server confirmed elsewhere (a fresh read, a version save). Older than `base`,
   * or in conflict or rejected: ignored. While a request is in flight or a failure is unresolved: kept, and weighed
   * against the next answer (a newer other text then is a conflict, never "saved"). With the same text as `base` (only
   * the counter moved): it becomes the base, and local edits are kept. Otherwise it replaces the text only when there
   * are no local edits; local edits win, and their next save meets the conflict.
   */
  refresh(confirmed: Draft): void;
  /** The current state; the same object until something changes, as `useSyncExternalStore` requires. */
  getSnapshot(): AutosaveState;
  /** Calls `listener` after every state change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Cancels the timers, ignores the response in flight and settles pending flushes as `disposed`. */
  dispose(): void;
}

const defaultRetryDelayMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 30_000);

const globalTimers: Timers = {
  // Looked up on each call, so fake timers installed after the machine was created still apply.
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

const sameState = (a: AutosaveState, b: AutosaveState): boolean => {
  if (a.status !== b.status || a.content !== b.content || a.base !== b.base) return false;
  if (a.status === 'retrying' && b.status === 'retrying') return a.error === b.error && a.attempt === b.attempt;
  if (a.status === 'conflict' && b.status === 'conflict') return a.server === b.server;
  if (a.status === 'rejected' && b.status === 'rejected') return a.error === b.error && a.permanent === b.permanent;
  return true;
};

export const createAutosave = (options: AutosaveOptions): Autosave => {
  const { save, debounceMs = 1000, retryDelayMs = defaultRetryDelayMs, timers = globalTimers } = options;

  let base = options.base;
  let content = base.content;
  /** Incremented on every edit, so a flush knows which edits it waits for. */
  let editSeq = 0;
  /** Edits up to this number are saved on the server. */
  let savedSeq = 0;
  let inFlight = false;
  let timer: unknown;
  let failures = 0;
  /**
   * A request failed, so whether the server holds `base` or what was sent is unknown. Until a save succeeds or a
   * conflict says what the server holds, text equal to `base` is not known to be saved.
   */
  let uncertain = false;
  let lastError: unknown;
  /** The server's draft while in conflict. */
  let server: Draft | undefined;
  /**
   * The last text the server refused, kept after the writer moved on: it is never sent again (and nothing is, if
   * `permanent`). `rejected` says whether the machine shows it, that is whether the local text is still that one.
   */
  let refusal: { error: unknown; permanent: boolean; content: string } | undefined;
  let rejected = false;
  /**
   * The newest draft the server confirmed elsewhere while a request was in flight or its outcome unknown. It is
   * reconciled with the next answer before the text is called saved.
   */
  let later: Draft | undefined;
  let disposed = false;
  const flushes: { seq: number; settle: (outcome: FlushOutcome) => void }[] = [];
  const listeners = new Set<() => void>();

  /** Whether the local text still has to be sent for the server to hold it. */
  const needsSave = () => uncertain || content !== base.content;

  const computeState = (): AutosaveState => {
    const common = { content, base };
    if (rejected && refusal !== undefined) {
      return { ...common, status: 'rejected', error: refusal.error, permanent: refusal.permanent };
    }
    if (server !== undefined) return { ...common, status: 'conflict', server };
    if (failures > 0) return { ...common, status: 'retrying', error: lastError, attempt: failures };
    if (inFlight) return { ...common, status: 'saving' };
    if (needsSave()) return { ...common, status: 'unsaved' };
    return { ...common, status: 'saved' };
  };

  let snapshot = computeState();

  const update = () => {
    const next = computeState();
    if (sameState(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      // A listener may dispose the machine: the ones after it must not run.
      if (disposed) return;
      listener();
    }
  };

  const settleFlushes = (outcome: FlushOutcome, all: boolean) => {
    for (let i = flushes.length - 1; i >= 0; i--) {
      const flush = flushes[i];
      if (flush !== undefined && (all || flush.seq <= savedSeq)) {
        flushes.splice(i, 1);
        flush.settle(outcome);
      }
    }
  };

  const clearTimer = () => {
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (ms: number) => {
    clearTimer();
    timer = timers.setTimeout(() => {
      timer = undefined;
      send();
    }, ms);
  };

  /** The local text matches the server's draft: everything edited so far is saved. */
  const markClean = () => {
    savedSeq = editSeq;
    failures = 0;
    lastError = undefined;
    settleFlushes('saved', false);
  };

  /**
   * Weighs `later` against the base the server has just confirmed. Older: forgotten. The same text, or the local text:
   * it becomes the base. Another text: the other device wrote after this save, so it is a conflict. Returns whether so.
   */
  const supersededByLater = (): boolean => {
    const confirmed = later;
    later = undefined;
    if (confirmed === undefined || confirmed.draftVersion <= base.draftVersion) return false;
    if (confirmed.content === base.content || confirmed.content === content) {
      base = confirmed;
      return false;
    }
    server = confirmed;
    return true;
  };

  const settle = (sent: Draft, seq: number, result: SaveResult) => {
    switch (result.kind) {
      case 'saved':
        base = { content: sent.content, draftVersion: result.draftVersion };
        uncertain = false;
        failures = 0;
        lastError = undefined;
        if (supersededByLater()) {
          settleFlushes('conflict', true);
          break;
        }
        savedSeq = Math.max(savedSeq, seq);
        settleFlushes('saved', false);
        // Text typed during the request goes right away, based on the version it returned.
        send();
        return;
      case 'conflict': {
        uncertain = false;
        const newest = later !== undefined && later.draftVersion > result.server.draftVersion ? later : result.server;
        later = undefined;
        if (newest.content === base.content && newest.draftVersion > base.draftVersion) {
          // Only the counter moved: the server holds the text the local edits started from, so nothing of anyone's is
          // overwritten by sending them again on its version.
          base = newest;
          failures = 0;
          lastError = undefined;
          send();
          return;
        }
        server = newest;
        settleFlushes('conflict', true);
        break;
      }
      case 'failed':
        failures++;
        uncertain = true;
        lastError = result.error;
        settleFlushes('failed', true);
        schedule(retryDelayMs(failures));
        break;
      case 'rejected':
        refusal = { error: result.error, permanent: result.permanent, content: sent.content };
        if (!result.permanent && content !== sent.content) {
          // The writer already changed the refused text: save what they have now.
          send();
          return;
        }
        rejected = true;
        settleFlushes('rejected', true);
        break;
    }
    update();
  };

  const request = async (sent: Draft, seq: number) => {
    let result: SaveResult;
    try {
      result = await save(sent);
    } catch (error) {
      result = { kind: 'failed', error };
    }
    inFlight = false;
    if (disposed) return;
    settle(sent, seq, result);
  };

  /**
   * Sends the latest text now, unless a request is already in flight (it is sent after it), in conflict, or the text is
   * one the server refused (the machine shows the refusal instead).
   */
  const send = () => {
    if (disposed || inFlight || server !== undefined || rejected) return;
    clearTimer();
    if (!needsSave()) {
      markClean();
      update();
      return;
    }
    if (refusal !== undefined && (refusal.permanent || refusal.content === content)) {
      rejected = true;
      settleFlushes('rejected', true);
      update();
      return;
    }
    inFlight = true;
    void request({ content, draftVersion: base.draftVersion }, editSeq);
    update();
  };

  /**
   * Leaves the rejected state when the text is no longer the refused one (the refusal itself is kept). Returns whether
   * still rejected.
   */
  const stillRejected = () => {
    if (!rejected || refusal === undefined) return false;
    if (refusal.permanent || refusal.content === content) return true;
    rejected = false;
    failures = 0;
    lastError = undefined;
    return false;
  };

  return {
    edit(next) {
      if (disposed || next === content) return;
      content = next;
      editSeq++;
      stillRejected();
      if (server === undefined && !rejected && !inFlight) {
        if (!needsSave()) {
          clearTimer();
          markClean();
        } else {
          // Also replaces a pending retry: a new edit retries earlier than the backoff would.
          schedule(debounceMs);
        }
      }
      update();
    },

    flush() {
      if (disposed) return Promise.resolve('disposed');
      if (stillRejected()) return Promise.resolve('rejected');
      if (server !== undefined) return Promise.resolve('conflict');
      if (!inFlight && !needsSave()) return Promise.resolve('saved');
      const done = new Promise<FlushOutcome>((settle) => flushes.push({ seq: editSeq, settle }));
      send();
      return done;
    },

    resolve(next, confirmed) {
      if (disposed || server === undefined) return;
      base = confirmed;
      server = undefined;
      failures = 0;
      lastError = undefined;
      content = next;
      editSeq++;
      send();
      update();
    },

    refresh(confirmed) {
      if (disposed || server !== undefined || rejected) return;
      if (confirmed.draftVersion <= base.draftVersion) return;
      if (inFlight || uncertain) {
        // The answer to come may be older: weigh this one against it then.
        if (later === undefined || confirmed.draftVersion > later.draftVersion) later = confirmed;
        return;
      }
      if (confirmed.content === base.content) {
        base = confirmed;
      } else if (content === base.content) {
        base = confirmed;
        content = confirmed.content;
        editSeq++;
        clearTimer();
        markClean();
      }
      update();
    },

    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      settleFlushes('disposed', true);
      listeners.clear();
    },
  };
};
