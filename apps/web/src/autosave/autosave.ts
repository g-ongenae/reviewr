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
   * Tells the machine about a draft the server confirmed elsewhere (a fresh read, a version save). Not newer than
   * `base`: ignored. On a `saved` machine with nothing pending: it replaces the text. Otherwise it is kept and
   * reconciled as soon as no answer is pending: holding one of this machine's texts (the local text, the base, a text
   * it sent), it becomes the base and local edits are sent on it; holding another text, it is a conflict, and the
   * local text stays. Never "saved" for a text older than it. In conflict, a draft newer than the server's that does
   * not hold the local text becomes the server's draft of the conflict.
   */
  refresh(confirmed: Draft): void;
  /** The current state; the same object until something changes, as `useSyncExternalStore` requires. */
  getSnapshot(): AutosaveState;
  /** Calls `listener` after every state change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Cancels the timers, ignores the response in flight and settles pending flushes as `disposed`. */
  dispose(): void;
}

/**
 * A short stand-in for a text: its length and a 53-bit hash of its characters (cyrb53). Two different texts with
 * the same fingerprint are treated as the same text. For refused texts this errs on the safe side: such a text is
 * shown as refused without having been sent, it stays on screen, and a later edit whose fingerprint was not refused
 * is saved as usual.
 */
const fingerprint = (text: string): string => {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);

  return `${text.length}:${(4294967296 * (2097151 & low) + (high >>> 0)).toString(36)}`;
};

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
   * A request failed, so whether the server holds `base` or what was sent (`unknownText`) is unknown. Until an answer
   * or a newer confirmed draft says what the server holds, text equal to `base` is not known to be saved.
   */
  let uncertain = false;
  let unknownText: string | undefined;
  let lastError: unknown;
  /** The server's draft while in conflict. */
  let server: Draft | undefined;
  /**
   * The texts the server refused, remembered after the writer moved on: none is ever sent again (and nothing is,
   * after a `permanent` refusal). Only their fingerprints are kept: a refused text can be a whole document, and a
   * writer correcting it bit by bit would otherwise leave every refused copy in memory. `refusal` is the last
   * refusal, which the state shows; `rejected` says whether the machine shows it, that is whether the local text is
   * a refused one.
   */
  const refused = new Set<string>();
  const isRefused = (text: string): boolean => refused.size > 0 && refused.has(fingerprint(text));
  let refusal: { error: unknown; permanent: boolean } | undefined;
  let rejected = false;
  /**
   * The newest confirmed draft the machine was told about (a read, a 409) and has not reconciled yet: it may be older
   * or newer than the answer of a request in flight, so it waits for that answer. `reconcile` consumes it.
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
      advance('now');
    }, ms);
  };

  /** Keeps a confirmed draft for `reconcile`, if it is newer than the base and than the one already kept. */
  const keep = (confirmed: Draft) => {
    if (confirmed.draftVersion <= base.draftVersion) return;
    if (later === undefined || confirmed.draftVersion > later.draftVersion) later = confirmed;
  };

  /**
   * Consumes `later`, once no answer is pending. Not newer than the base: forgotten. Holding a text of this machine
   * (the local text, the base, the text just sent or whose save is unknown): it becomes the base, and the local text
   * is sent on it if it differs. Another text: another device wrote it, so it is a conflict, and the local text stays.
   */
  const reconcile = (sent?: string) => {
    const confirmed = later;
    later = undefined;
    if (confirmed === undefined || confirmed.draftVersion <= base.draftVersion) return;
    const ours = [content, base.content, sent, unknownText];
    if (ours.includes(confirmed.content)) {
      base = confirmed;
      uncertain = false;
      unknownText = undefined;
      failures = 0;
      lastError = undefined;
    } else {
      server = confirmed;
    }
  };

  /**
   * The one place that decides what comes next, and the only one that calls the text saved. `now` sends at once,
   * `debounce` (re)starts the debounce, `keep` leaves a pending timer as it is.
   *
   * Invariant: the status is `saved` only when the local text is the text of the newest confirmed draft the machine
   * has been given. So `later` is reconciled first, and nothing is called saved while an answer is pending.
   */
  const advance = (mode: 'now' | 'debounce' | 'keep') => {
    if (disposed) return;
    if (!inFlight && server === undefined) reconcile();
    if (rejected && refusal !== undefined && !refusal.permanent && !isRefused(content)) rejected = false;

    if (rejected) {
      clearTimer();
      settleFlushes('rejected', true);
    } else if (server !== undefined) {
      clearTimer();
      settleFlushes('conflict', true);
    } else if (inFlight) {
      // The text is sent after the answer.
    } else if (!needsSave()) {
      clearTimer();
      savedSeq = editSeq;
      failures = 0;
      lastError = undefined;
      settleFlushes('saved', false);
    } else if (refusal !== undefined && (refusal.permanent || isRefused(content))) {
      clearTimer();
      rejected = true;
      settleFlushes('rejected', true);
    } else if (mode === 'now') {
      clearTimer();
      inFlight = true;
      void request({ content, draftVersion: base.draftVersion }, editSeq);
    } else if (mode === 'debounce' || timer === undefined) {
      // Also replaces a pending retry: a new edit retries earlier than the backoff would.
      schedule(debounceMs);
    }
    update();
  };

  const settle = (sent: Draft, seq: number, result: SaveResult) => {
    switch (result.kind) {
      case 'saved':
        base = { content: sent.content, draftVersion: result.draftVersion };
        uncertain = false;
        unknownText = undefined;
        failures = 0;
        lastError = undefined;
        reconcile();
        if (server === undefined) {
          savedSeq = Math.max(savedSeq, seq);
          settleFlushes('saved', false);
        }
        // Text typed during the request goes right away, based on the version it returned.
        advance('now');
        return;
      case 'conflict':
        // The text sent did not land: the server holds `result.server`, or a newer draft read meanwhile. That draft may
        // be a text of this machine whose answer was lost (`unknownText`): then it is the base, not a conflict.
        uncertain = false;
        failures = 0;
        lastError = undefined;
        keep(result.server);
        reconcile(sent.content);
        unknownText = undefined;
        advance('now');
        return;
      case 'failed':
        failures++;
        uncertain = true;
        unknownText = sent.content;
        lastError = result.error;
        settleFlushes('failed', true);
        schedule(retryDelayMs(failures));
        advance('keep');
        return;
      case 'rejected':
        refused.add(fingerprint(sent.content));
        refusal = { error: result.error, permanent: result.permanent };
        if (result.permanent) rejected = true;
        // A text the writer changed meanwhile is sent at once; the refused one never is.
        advance('now');
        return;
    }
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

  return {
    edit(next) {
      if (disposed || next === content) return;
      content = next;
      editSeq++;
      advance('debounce');
    },

    flush() {
      if (disposed) return Promise.resolve('disposed');
      const done = new Promise<FlushOutcome>((settle) => flushes.push({ seq: editSeq, settle }));
      advance('now');
      return done;
    },

    resolve(next, confirmed) {
      if (disposed || server === undefined) return;
      server = undefined;
      base = confirmed;
      failures = 0;
      lastError = undefined;
      content = next;
      editSeq++;
      advance('now');
    },

    refresh(confirmed) {
      if (disposed || confirmed.draftVersion <= base.draftVersion) return;
      if (snapshot.status === 'saved' && later === undefined) {
        // No local edits, nothing pending: the newer draft simply replaces the text.
        base = confirmed;
        content = confirmed.content;
        editSeq++;
        advance('keep');
        return;
      }
      keep(confirmed);
      // In conflict, a newer draft from another device is the one to reconcile with now. One holding the local text
      // (a step of a reconciliation that did not finish) is not: it stays kept, for after `resolve`.
      if (server !== undefined && confirmed.draftVersion > server.draftVersion && confirmed.content !== content) {
        server = confirmed;
      }
      advance('keep');
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
