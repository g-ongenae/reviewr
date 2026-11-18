import type { CreateRevisionInput, Document } from '@reviewr/shared';
import { conflictOf } from '@reviewr/shared';
import type { Draft, SaveDraft, SaveResult } from './autosave';

/** A "Save version" made while the draft could not be saved: the text on screen at that moment, and its name. */
export interface QueuedVersion {
  readonly text: string;
  readonly name: string | undefined;
}

/**
 * Why a queued version was not created, and is held for the writer to copy or discard: the draft was changed on
 * another device (`conflict`), the server refused its text (`refused`), or the document is gone (`deleted`).
 */
export type HoldReason = 'conflict' | 'refused' | 'deleted';

export interface HeldVersion extends QueuedVersion {
  readonly reason: HoldReason;
}

export interface VersionQueueState {
  /** The versions still to create, in the order they were saved. */
  readonly pending: readonly QueuedVersion[];
  /** The versions that will not be created, until the writer discards them. */
  readonly held: readonly HeldVersion[];
}

export interface VersionQueueOptions {
  createRevision: (input: CreateRevisionInput) => Promise<Document>;
  /** The head revision as last read: the base of the first version created. */
  head: () => number;
  /** What a failed request means (see `toSaveResult`). */
  toSaveResult: (error: unknown) => SaveResult;
  /** A version was created (or the server said its text already is the head). */
  onRevision?: (document: Document) => void;
}

export interface VersionQueue {
  /** Queues a version. The same text as the last one queued is the same version: it only gives it a missing name. */
  enqueue: (version: QueuedVersion) => void;
  /** The writer discards a held version. */
  discard: (text: string) => void;
  /** Whether versions wait to be created: the autosave machine is never saved meanwhile (its `mustSave`). */
  hasPending: () => boolean;
  /**
   * The autosave machine's `save`, around the document's own `save`: the queued versions first, each its text saved as
   * the draft then made a revision, in order; then `draft`. One request at a time, since the machine calls it so.
   */
  send: (draft: Draft, save: SaveDraft, uncreated?: () => boolean) => Promise<SaveResult>;
  getSnapshot: () => VersionQueueState;
  subscribe: (listener: () => void) => () => void;
}

/** How many times a version is tried again on a head that moved elsewhere (the draft did not), within one send. */
const staleAttempts = 3;

const empty: VersionQueueState = { pending: [], held: [] };

/**
 * The versions saved while the server was unreachable, for one document, in memory.
 *
 * **Order.** On the server's return, before the latest text, each queued text is saved as the draft on the draft
 * version this device last confirmed, then made a revision: the history ends as if the writer had been online. A text
 * already the draft is answered as saved, and a text already the head makes no revision, so sending a step again after
 * a lost answer creates nothing twice.
 *
 * **Conflicts.** A queued version is created only on a draft this device confirmed. When the draft moved elsewhere (a
 * `draft_conflict` on any step), no queued text is written over the other device's: every pending version is held,
 * readable and copyable, until the writer discards it, and the latest text goes through the machine's usual conflict.
 * A text the server refuses (too large) is held too; a deleted document holds them all.
 *
 * **Progress.** When a send stops after some steps, the machine is told the draft the server holds now (a `saved`
 * naming another text than the one sent), so that its base, its next request and any read agree with the server.
 */
export const createVersionQueue = (options: VersionQueueOptions): VersionQueue => {
  const { createRevision, head, toSaveResult, onRevision } = options;
  let state = empty;
  const listeners = new Set<() => void>();
  /** The newest draft version a step confirmed: the machine's base may lag behind it after a failed send. */
  let known = 0;
  /** The newest head a version answered with: the cache may not have it yet. */
  let lastHead = 0;

  const set = (next: VersionQueueState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const hold = (versions: readonly QueuedVersion[], reason: HoldReason) => {
    const held = [...state.held];
    for (const { text, name } of versions) {
      if (!held.some((version) => version.text === text)) held.push({ text, name, reason });
    }
    set({ pending: state.pending.filter((version) => !versions.includes(version)), held });
  };

  /** Makes the draft of `draftVersion` a revision: done, or why not. */
  const revise = async (
    { name }: QueuedVersion,
    draftVersion: number,
  ): Promise<{ kind: 'done' } | Exclude<SaveResult, { kind: 'saved' }>> => {
    let baseRevision = Math.max(head(), lastHead);
    for (let attempt = 1; ; attempt++) {
      try {
        const saved = await createRevision({
          name,
          draftVersion,
          baseRevision: baseRevision === 0 ? null : baseRevision,
        });
        lastHead = Math.max(lastHead, saved.revision);
        onRevision?.(saved);
        return { kind: 'done' };
      } catch (error) {
        const conflict = conflictOf(error);
        if (conflict?.code === 'stale_revision' && attempt < staleAttempts) {
          baseRevision = conflict.revision;
          continue;
        }
        if (conflict?.code === 'draft_conflict') {
          const { content, draftVersion: version } = conflict.draft;
          return { kind: 'conflict', server: { content, draftVersion: version } };
        }
        // A head that keeps moving is tried again later, as a failure.
        const result = conflict === undefined ? toSaveResult(error) : undefined;
        return result === undefined || result.kind === 'saved' ? { kind: 'failed', error } : result;
      }
    }
  };

  const send = async (draft: Draft, save: SaveDraft, uncreated: () => boolean = () => false): Promise<SaveResult> => {
    if (state.pending.length === 0) return save({ ...draft, draftVersion: Math.max(draft.draftVersion, known) });
    let version = Math.max(draft.draftVersion, known);
    /** The draft the server holds after the last step that succeeded in this send. */
    let progress: Draft | undefined;
    const confirm = (content: string, draftVersion: number) => {
      version = draftVersion;
      known = Math.max(known, draftVersion);
      progress = { content, draftVersion };
    };
    /**
     * The send stops on `result`. The machine first learns the draft the server holds now, when it is news to it (a
     * newer version, holding another text than the one sent): it sends again at once, and meets `result` then. Otherwise
     * it gets `result`, and a failure is retried after its backoff.
     */
    const stop = (result: SaveResult): SaveResult =>
      progress !== undefined && progress.content !== draft.content && progress.draftVersion > draft.draftVersion
        ? { kind: 'saved', draftVersion: progress.draftVersion, content: progress.content }
        : result;

    // A page not created yet: its creation comes first, as it would have online.
    if (uncreated()) {
      const created = await save(draft);
      if (created.kind !== 'saved') return created;
      confirm(created.content ?? draft.content, created.draftVersion);
    }

    for (let queued = state.pending[0]; queued !== undefined; queued = state.pending[0]) {
      const saved = await save({ content: queued.text, draftVersion: version });
      if (saved.kind === 'conflict') {
        hold(state.pending, 'conflict');
        return stop(saved);
      }
      if (saved.kind === 'rejected') {
        if (saved.permanent) {
          hold(state.pending, 'deleted');
          return stop(saved);
        }
        hold([queued], 'refused');
        continue;
      }
      if (saved.kind === 'failed') return stop(saved);
      confirm(saved.content ?? queued.text, saved.draftVersion);

      const revised = await revise(queued, version);
      if (revised.kind === 'done') {
        set({ ...state, pending: state.pending.filter((pending) => pending !== queued) });
        continue;
      }
      if (revised.kind === 'conflict') {
        hold(state.pending, 'conflict');
        return stop(revised);
      }
      if (revised.kind === 'rejected') {
        if (revised.permanent) {
          hold(state.pending, 'deleted');
          return stop(revised);
        }
        hold([queued], 'refused');
        continue;
      }
      return stop(revised);
    }

    // The server holds the latest text already: nothing more to send.
    if (progress !== undefined && progress.content === draft.content) {
      return { kind: 'saved', draftVersion: progress.draftVersion };
    }
    return save({ content: draft.content, draftVersion: version });
  };

  return {
    enqueue: (version) => {
      const last = state.pending.at(-1);
      if (last?.text === version.text) {
        if (last.name !== undefined || version.name === undefined) return;
        set({ ...state, pending: [...state.pending.slice(0, -1), { text: last.text, name: version.name }] });
        return;
      }
      set({ ...state, pending: [...state.pending, version] });
    },
    discard: (text) => {
      if (!state.held.some((version) => version.text === text)) return;
      set({ ...state, held: state.held.filter((version) => version.text !== text) });
    },
    hasPending: () => state.pending.length > 0,
    send,
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
