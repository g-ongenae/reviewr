import type { AutosaveState } from '@reviewr/autosave';
import type { BufferBase, BufferFailureReason, LocalBuffer } from './localBuffer';

/**
 * The copy of the text being written that the phone keeps in the local buffer until the server confirmed it: the
 * web's `deviceBuffer.ts`, without its tabs (the phone has one writer, and one row per document, keyed by its id).
 *
 * It mirrors the autosave machines and never decides for them: each document's machine state is written as it changes
 * (its local text and the base it was written from), and the row is deleted once the machine says `saved`. A buffer
 * that fails changes nothing in memory: the machines go on saving to the server, the next state change writes the
 * latest text again, and the writer is told once (`failure`).
 *
 * Three rules, each in one place:
 *
 * 1. **The scan comes first** (`scan`). The buffer is read once, as the copy is created. No write reaches the database
 *    before that read answered, and none at all in this run if it failed: what the buffer holds is then unknown, and a
 *    write could replace a text kept there. That text comes back at the next start where the buffer can be read.
 * 2. **Only an owned row is deleted** (`drain`). A row is owned once a put of this run landed in it, or once its
 *    document took over the text the scan read in it (`claim`). A row this run could not read or write (written by a
 *    newer build, damaged) is never deleted by this build.
 * 3. **A confirmation deletes the owned row whatever it holds.** The server holds the machine's text, and every text
 *    this run put before it is one the writer moved on from (typed over, undone). Calls run in order, so that delete
 *    never removes a text put after it. A put that timed out may still commit (its outcome is unknown until the buffer
 *    answers again): a row not owned is then deleted only if it holds exactly one of those texts, which only this run
 *    can have written. A clean-up that fails is tried again on its own, with a backoff, until it lands or a newer put
 *    makes it needless: the machine may stay `saved` with no other change until the app exits.
 *
 * **What a kill can lose.** A text is kept once its put answered `ok`. Until then it is in memory only: the newest
 * text waits behind the put in progress, and puts not started yet are coalesced, so a kill brings back the last text
 * whose put landed, never an older one than that.
 */
export interface LocalCopy {
  /** Writes the state of a document's machine: its text and base until the server confirmed it, then a delete. */
  mirror(id: string, state: AutosaveState): void;
  /** The text the scan found for `id` that no document took over yet; `undefined` if none, or if the scan failed. */
  kept(id: string): Promise<KeptRow | undefined>;
  /** The document `id` takes over its kept text, and its row is now owned. `false` if it was taken already. */
  claim(id: string): boolean;
  /** Deletes the row of `id` if it is owned: the server holds its text already, or the writer deleted the document. */
  forget(id: string): void;
  /** Settles once the scan and every write queued so far were answered, ok or not. */
  settled(): Promise<void>;
  /** Why the buffer could not keep a text, the first time it could not; `undefined` while it always could. */
  failure(): BufferFailureReason | undefined;
  /** Whether the writer dismissed the notice: it is shown once. */
  dismissed(): boolean;
  dismiss(): void;
  subscribe(listener: () => void): () => void;
}

/** A text kept for a document that exists on the server, with the base it was written from. */
export interface KeptRow {
  content: string;
  base: BufferBase;
}

/** A write of a document's row. */
type Op = { kind: 'put'; content: string; base: BufferBase } | { kind: 'delete' };

/** What the phone writes for one document: one operation at a time, in order, consecutive puts coalesced. */
interface Mirror {
  queue: Op[];
  running: boolean;
  /**
   * The last operation queued, to skip repeats. Cleared when a put fails, so that the next one is not skipped; a failed
   * clean-up stays, and is tried again while it is the last (`retryLater`).
   */
  last?: Op;
  /** Whether a put was queued since the last delete: only then is a confirmation worth a delete. */
  dirty: boolean;
  /** Whether the row is this run's to delete (rule 2). */
  owned: boolean;
  /**
   * The texts of puts that timed out since the last write that landed: each may still commit. Bounded by the edits made
   * while one statement hangs, and cleared once a write lands (the hung statement settled before it).
   */
  unknown: Set<string>;
  /** How many times in a row the clean-up failed, for its backoff. */
  retries: number;
}

/** Delay before the `attempt`-th new try of a failed clean-up: 1 s, 2 s, 4 s… up to 30 s. */
const retryDelayMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 30_000);

const sameOp = (a: Op | undefined, b: Op): boolean => {
  if (a === undefined || a.kind !== b.kind) return false;
  if (a.kind === 'put' && b.kind === 'put') return a.content === b.content && a.base === b.base;
  return true;
};

export const createLocalCopy = (buffer: LocalBuffer): LocalCopy => {
  const mirrors = new Map<string, Mirror>();
  const listeners = new Set<() => void>();
  /** The kept texts no document took over yet. */
  const keptRows = new Map<string, KeptRow>();
  let failed: BufferFailureReason | undefined;
  let dismissed = false;
  const idle: (() => void)[] = [];

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const report = (reason: BufferFailureReason) => {
    if (failed !== undefined) return;
    failed = reason;
    notify();
  };

  let scanning = true;
  const busy = () => scanning || [...mirrors.values()].some((mirror) => mirror.running || mirror.queue.length > 0);
  const settleIdle = () => {
    if (!busy()) for (const resolve of idle.splice(0)) resolve();
  };

  /** Rule 1: whether the buffer was read. Every write waits for it. */
  const scan: Promise<boolean> = buffer.list().then((result) => {
    scanning = false;
    if (!result.ok) report(result.reason);
    // Rows without a base are pages not created on the server yet: the phone writes none, and leaves them.
    else for (const { key, content, base } of result.entries) if (base !== null) keptRows.set(key, { content, base });
    settleIdle();
    return result.ok;
  });

  /**
   * Deletes what this run wrote in the row (rule 3): the owned row, or a row holding exactly a text whose put timed out.
   * `true` once nothing this run wrote can be left there.
   */
  const cleanUp = async (id: string, mirror: Mirror): Promise<boolean> => {
    if (mirror.owned) {
      const result = await buffer.delete(id);
      if (!result.ok) {
        report(result.reason);
        return false;
      }
      mirror.owned = false;
      mirror.unknown.clear();
      return true;
    }
    for (const content of [...mirror.unknown]) {
      // An unreadable row answers `unreadable` and is never removed; a row holding another text is not touched.
      const result = await buffer.delete(id, { ifContent: content });
      if (!result.ok) {
        report(result.reason);
        return false;
      }
      // Answered: the hung statement settled before, so the row cannot take this text any more.
      mirror.unknown.delete(content);
    }
    return true;
  };

  /** Tries a failed clean-up again later, unless a newer write replaced it meanwhile. */
  const retryLater = (id: string, mirror: Mirror, op: Op) => {
    mirror.retries++;
    setTimeout(() => {
      if (mirror.last !== op) return;
      mirror.queue.push(op);
      void drain(id, mirror);
    }, retryDelayMs(mirror.retries));
  };

  const drain = async (id: string, mirror: Mirror) => {
    if (mirror.running) return;
    mirror.running = true;
    const usable = await scan;
    for (let op = mirror.queue.shift(); op !== undefined; op = mirror.queue.shift()) {
      if (!usable) {
        mirror.queue.length = 0;
      } else if (op.kind === 'put') {
        const result = await buffer.put(id, { content: op.content, base: op.base });
        if (result.ok) {
          mirror.owned = true;
          mirror.unknown.clear();
          mirror.retries = 0;
        } else {
          report(result.reason);
          if (result.reason === 'stalled') mirror.unknown.add(op.content);
          if (mirror.queue.length === 0) mirror.last = undefined;
        }
      } else if (!(await cleanUp(id, mirror))) {
        retryLater(id, mirror, op);
      } else {
        mirror.retries = 0;
      }
    }
    mirror.running = false;
    settleIdle();
  };

  const mirrorOf = (id: string): Mirror => {
    let mirror = mirrors.get(id);
    if (mirror === undefined) {
      mirror = { queue: [], running: false, dirty: false, owned: false, unknown: new Set(), retries: 0 };
      mirrors.set(id, mirror);
    }
    return mirror;
  };

  const enqueue = (id: string, op: Op) => {
    const mirror = mirrorOf(id);
    if (sameOp(mirror.last, op)) return;
    if (op.kind === 'delete' && !mirror.dirty) return;
    mirror.last = op;
    mirror.dirty = op.kind === 'put';
    // Only the newest text matters: a put not started yet is replaced by the next one.
    const tail = mirror.queue.at(-1);
    if (op.kind === 'put' && tail?.kind === 'put') mirror.queue[mirror.queue.length - 1] = op;
    else mirror.queue.push(op);
    void drain(id, mirror);
  };

  return {
    mirror(id, state) {
      if (state.status === 'saved') enqueue(id, { kind: 'delete' });
      else enqueue(id, { kind: 'put', content: state.content, base: state.base });
    },

    async kept(id) {
      await scan;
      return keptRows.get(id);
    },

    claim(id) {
      if (!keptRows.delete(id)) return false;
      const mirror = mirrorOf(id);
      mirror.owned = true;
      mirror.dirty = true;
      return true;
    },

    forget(id) {
      const mirror = mirrorOf(id);
      // Writes not started yet are for a text the writer is done with.
      mirror.queue.length = 0;
      mirror.dirty = true;
      mirror.last = undefined;
      enqueue(id, { kind: 'delete' });
    },

    settled: () => (busy() ? new Promise<void>((resolve) => idle.push(resolve)) : Promise.resolve()),

    failure: () => failed,

    dismissed: () => dismissed,

    dismiss() {
      dismissed = true;
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
