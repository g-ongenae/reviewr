import type { AutosaveState, Draft } from '@reviewr/autosave';
import type { BufferEntry, BufferFailureReason, LocalBuffer } from './localBuffer';

/**
 * The copy of the text being written that the phone keeps in the local buffer until the server confirmed it: the
 * web's `deviceBuffer.ts`, without its tabs (the phone has one writer, and one row per document, keyed by its id).
 *
 * It mirrors the autosave machines and never decides for them: each document's machine state is written as it changes
 * (its local text and the base it was written from), and the row is deleted once the machine says `saved`, only if it
 * still holds that confirmed text. A buffer that fails changes nothing in memory: the machines go on saving to the
 * server, the next state change writes the latest text again, and the writer is told once (`failure`).
 *
 * **What a kill can lose.** A text is kept once its put answered `ok`. Until then it is in memory only: the newest
 * text waits behind the put in progress, and puts not started yet are coalesced, so a kill brings back the last text
 * whose put landed, never an older one than that.
 */
export interface LocalCopy {
  /** Writes the state of a document's machine: its text and base until the server confirmed it, then a delete. */
  mirror(id: string, state: AutosaveState): void;
  /** The row of `id` holds a text this mirror must delete once it is confirmed (a text restored from it). */
  adopt(id: string): void;
  /** Deletes the row of `id` if it still holds `content`: the server holds that very text. */
  drop(id: string, content: string): void;
  /** The writer is done with the document's text (they deleted the document): its row goes, whatever it holds. */
  forget(id: string): void;
  /** Every readable row, as the restore reads them, or why the buffer could not be read. */
  list(): Promise<{ entries: BufferEntry[] } | { failure: BufferFailureReason }>;
  /**
   * Writes nothing more for the rest of the run: the buffer could not be read, so a write could replace a text it
   * kept. The writer is told, as for any failure.
   */
  disable(): void;
  /** Settles once every write queued so far was answered, ok or not. */
  settled(): Promise<void>;
  /** Why the buffer could not keep a text, the first time it could not; `undefined` while it always could. */
  failure(): BufferFailureReason | undefined;
  /** Whether the writer was told and dismissed it: the notice is shown once. */
  dismissed(): boolean;
  dismiss(): void;
  subscribe(listener: () => void): () => void;
}

/** A write of a document's row. */
type Op = { kind: 'put'; content: string; base: Draft } | { kind: 'delete'; ifContent?: string };

/** What the phone writes for one document: one operation at a time, in order, consecutive puts coalesced. */
interface Mirror {
  queue: Op[];
  running: boolean;
  /** The last operation queued, to skip repeats; cleared when a write fails, so that the next one is not skipped. */
  last?: Op;
  /** Whether the row may hold a text of this mirror: only then is a confirmation worth a delete. */
  dirty: boolean;
  /**
   * A put failed (or stalled) since the last one that landed: the row may hold an older text than the one confirmed,
   * or the stalled one. The next confirmation then deletes the row whatever it holds: the phone is the only writer of
   * the row, and its calls run in order, so that delete cannot remove a later text.
   */
  stale: boolean;
}

const sameOp = (a: Op | undefined, b: Op): boolean => {
  if (a === undefined || a.kind !== b.kind) return false;
  if (a.kind === 'put' && b.kind === 'put') return a.content === b.content && a.base === b.base;
  return a.kind === 'delete' && b.kind === 'delete' && a.ifContent === b.ifContent;
};

export const createLocalCopy = (buffer: LocalBuffer): LocalCopy => {
  const mirrors = new Map<string, Mirror>();
  const listeners = new Set<() => void>();
  let failed: BufferFailureReason | undefined;
  let dismissed = false;
  let disabled = false;
  const idle: (() => void)[] = [];

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const report = (reason: BufferFailureReason) => {
    if (failed !== undefined) return;
    failed = reason;
    notify();
  };

  const busy = () => [...mirrors.values()].some((mirror) => mirror.running || mirror.queue.length > 0);

  const drain = async (id: string, mirror: Mirror) => {
    if (mirror.running) return;
    mirror.running = true;
    for (let op = mirror.queue.shift(); op !== undefined; op = mirror.queue.shift()) {
      if (op.kind === 'put') {
        const result = await buffer.put(id, { content: op.content, base: op.base });
        mirror.stale = !result.ok;
        if (!result.ok) {
          report(result.reason);
          if (mirror.queue.length === 0) mirror.last = undefined;
        }
      } else {
        const condition = op.ifContent !== undefined && !mirror.stale;
        const result = await buffer.delete(id, condition ? { ifContent: op.ifContent ?? '' } : undefined);
        if (result.ok) {
          // Nothing left that this mirror wrote: what a put that stalled may have written is gone with it.
          if (!condition) mirror.stale = false;
        } else {
          report(result.reason);
          // The row may still hold the text: the next confirmation tries again.
          mirror.dirty = true;
          if (mirror.queue.length === 0) mirror.last = undefined;
        }
      }
    }
    mirror.running = false;
    if (!busy()) for (const resolve of idle.splice(0)) resolve();
  };

  const mirrorOf = (id: string): Mirror => {
    let mirror = mirrors.get(id);
    if (mirror === undefined) {
      mirror = { queue: [], running: false, dirty: false, stale: false };
      mirrors.set(id, mirror);
    }
    return mirror;
  };

  const enqueue = (id: string, op: Op) => {
    if (disabled) return;
    const mirror = mirrorOf(id);
    if (sameOp(mirror.last, op)) return;
    if (op.kind === 'delete' && op.ifContent !== undefined && !mirror.dirty) return;
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
      if (state.status === 'saved') enqueue(id, { kind: 'delete', ifContent: state.content });
      else enqueue(id, { kind: 'put', content: state.content, base: state.base });
    },

    adopt(id) {
      mirrorOf(id).dirty = true;
    },

    drop(id, content) {
      const mirror = mirrorOf(id);
      mirror.dirty = true;
      enqueue(id, { kind: 'delete', ifContent: content });
    },

    forget(id) {
      const mirror = mirrorOf(id);
      // Writes not started yet are for a text the writer is done with.
      mirror.queue.length = 0;
      mirror.dirty = true;
      mirror.last = undefined;
      enqueue(id, { kind: 'delete' });
    },

    disable() {
      disabled = true;
      for (const mirror of mirrors.values()) mirror.queue.length = 0;
      report('unavailable');
    },

    async list() {
      const result = await buffer.list();
      if (!result.ok) {
        report(result.reason);
        return { failure: result.reason };
      }
      return { entries: result.entries };
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
