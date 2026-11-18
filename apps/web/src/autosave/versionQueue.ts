import type { CreateRevisionInput, Document } from '@reviewr/shared';
import { conflictOf } from '@reviewr/shared';
import type { Autosave, Draft, SaveDraft, SaveResult } from './autosave';

/** A "Save version": the text on screen when the writer asked for it, and its name. */
export interface QueuedVersion {
  readonly text: string;
  readonly name: string | undefined;
}

/**
 * Why a version was not created, and is held for the writer to copy or discard: the draft was changed on another device
 * (`conflict`), the server refused its text (`refused`), the document is gone (`deleted`), or its request may have
 * created it before its answer was lost, and the document moved since, so sending it again could create it twice
 * (`unsure`).
 */
export type HoldReason = 'conflict' | 'refused' | 'deleted' | 'unsure';

export interface HeldVersion extends QueuedVersion {
  readonly reason: HoldReason;
}

/** A queued version; `rename` when it only gives a name to the version of the same text queued before it. */
interface Pending extends QueuedVersion {
  readonly rename?: boolean;
}

export interface VersionQueueState {
  /** The versions still to create, in the order they were saved. */
  readonly pending: readonly QueuedVersion[];
  /** The versions that will not be created, until the writer discards them. */
  readonly held: readonly HeldVersion[];
}

export interface VersionQueueOptions {
  createRevision: (input: CreateRevisionInput) => Promise<Document>;
  /** Names a version: `PATCH /documents/:id/revisions/:n`. */
  nameRevision: (revision: number, name: string) => Promise<unknown>;
  /** The head revision as last read: the base of the first version created. */
  head: () => number;
  /** What a failed request means (see `toSaveResult`). */
  toSaveResult: (error: unknown) => SaveResult;
  /** A version was created (or the server said its text already is the head). */
  onRevision?: (document: Document) => void;
}

export interface VersionQueue {
  /**
   * Queues a version: every "Save version" goes through here, at the click, with its text and name. The same text as
   * the last one queued is the same version: a name given then names it, before its request is sent, or by a rename of
   * the version once it is created.
   */
  enqueue: (version: QueuedVersion) => void;
  /** Holds every version still to create (a conflict, a deleted document): none of them is sent any more. */
  holdAll: (reason: HoldReason) => void;
  /** The writer discards a held version. */
  discard: (text: string) => void;
  /** Whether versions wait to be created: the autosave machine is never saved meanwhile (its `mustSave`). */
  hasPending: () => boolean;
  /**
   * The autosave machine's `save`, around the document's own `save`: a page not created yet is created first, then each
   * queued text is saved as the draft and made a revision, in order; then `draft`. One request at a time, since the
   * machine calls it so.
   */
  send: (draft: Draft, save: SaveDraft, uncreated?: () => boolean) => Promise<SaveResult>;
  getSnapshot: () => VersionQueueState;
  subscribe: (listener: () => void) => () => void;
}

/** How many times a version is tried again on a head that moved elsewhere (the draft did not), within one send. */
const staleAttempts = 3;

const empty: VersionQueueState = { pending: [], held: [] };

/** How the revision of a version ended. */
type Revised =
  { kind: 'done' } | { kind: 'unsure' } | Extract<SaveResult, { kind: 'conflict' | 'failed' | 'rejected' }>;

/**
 * The versions of one document, in memory: each "Save version" is queued at the click, and created by the autosave
 * machine's next save, at once when the server is reachable, on its return otherwise.
 *
 * **Order.** Before the latest text, each queued text is saved as the draft, on the draft version the machine holds,
 * then made a revision: the history ends as if every request had been answered at once. A text already the draft is
 * answered as saved, and a draft already the head makes no revision.
 *
 * **What the machine learns.** A send that stops tells the machine the last draft it confirmed (`confirmed`) and which
 * write is uncertain (`unknown`), so that its base, the local buffer's base, a read and a 409 agree with the server.
 * A 409 on any step is handed to the machine, which decides whether the server holds one of its own texts or another
 * device's; once it is a conflict, the registry holds every pending version (`holdAll`) before a resolution can restart
 * the saves. No queued text is ever written over another device's draft.
 *
 * **A lost answer to a revision.** The request may have created the version. It is sent again only on the very draft
 * counter and head it was sent on (then the server's own rules make it create nothing twice); if either moved, the
 * version is held as `unsure`, for the writer to check in the history.
 */
export const createVersionQueue = (options: VersionQueueOptions): VersionQueue => {
  const { createRevision, nameRevision, head, toSaveResult, onRevision } = options;
  let state: { pending: readonly Pending[]; held: readonly HeldVersion[] } = empty;
  const listeners = new Set<() => void>();
  /** The newest head a version answered with: the cache may not have it yet. */
  let lastHead = 0;
  /** The version whose requests are being sent: a name given for its text then goes to a rename. */
  let active: Pending | undefined;
  /** Revisions whose answer was lost: the draft counter and the head they were sent on. */
  const posted = new WeakMap<Pending, { draftVersion: number; baseRevision: number }>();

  const set = (next: typeof state) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const hold = (versions: readonly Pending[], reason: HoldReason) => {
    if (versions.length === 0) return;
    const held = [...state.held];
    for (const { text, name } of versions) {
      const same = held.findIndex((version) => version.text === text);
      // A rename holds the name it was to give; the text is held once.
      if (same === -1) held.push({ text, name, reason });
      else if (name !== undefined) held[same] = { text, name, reason: held[same]?.reason ?? reason };
    }
    set({ pending: state.pending.filter((version) => !versions.includes(version)), held });
  };

  const remove = (version: Pending) => set({ ...state, pending: state.pending.filter((item) => item !== version) });

  /** Makes the draft of `draftVersion`, which holds `version`'s text, a revision. */
  const revise = async (version: Pending, draftVersion: number): Promise<Revised> => {
    const lost = posted.get(version);
    let baseRevision = lost?.baseRevision ?? Math.max(head(), lastHead);
    for (let attempt = 1; ; attempt++) {
      let saved: Document;
      try {
        saved = await createRevision({
          name: version.rename ? undefined : version.name,
          draftVersion,
          baseRevision: baseRevision === 0 ? null : baseRevision,
        });
      } catch (error) {
        const conflict = conflictOf(error);
        if (conflict?.code === 'stale_revision') {
          // The head moved: after a lost answer, the version may be the head's parent already.
          if (lost !== undefined) return { kind: 'unsure' };
          if (attempt < staleAttempts) {
            baseRevision = conflict.revision;
            continue;
          }
          return { kind: 'failed', error };
        }
        if (conflict?.code === 'draft_conflict') {
          const { content, draftVersion: version } = conflict.draft;
          return { kind: 'conflict', server: { content, draftVersion: version } };
        }
        const result = toSaveResult(error);
        if (result.kind === 'rejected') return result;
        // The request may have created the version: it is sent again only on what it was sent on.
        posted.set(version, { draftVersion, baseRevision });
        return { kind: 'failed', error };
      }
      lastHead = Math.max(lastHead, saved.revision);
      onRevision?.(saved);
      if (version.rename && version.name !== undefined) {
        try {
          await nameRevision(saved.revision, version.name);
        } catch (error) {
          const result = toSaveResult(error);
          if (result.kind === 'rejected') return result;
          // The version exists: sent again on the same draft, its revision creates nothing, and the name follows.
          posted.set(version, { draftVersion, baseRevision: saved.revision });
          return { kind: 'failed', error };
        }
      }
      return { kind: 'done' };
    }
  };

  const send = async (draft: Draft, save: SaveDraft, uncreated: () => boolean = () => false): Promise<SaveResult> => {
    if (state.pending.length === 0) return save(draft);
    let draftVersion = draft.draftVersion;
    /** The draft the server holds after the last write of this send that it confirmed. */
    let confirmed: Draft | undefined;
    const confirm = (content: string, version: number) => {
      draftVersion = version;
      confirmed = { content, draftVersion: version };
    };
    /** The send ends on `result`; the machine first takes the draft confirmed on the way as its base. */
    const end = (result: SaveResult): SaveResult =>
      result.kind === 'saved' || confirmed === undefined ? result : { ...result, confirmed };

    // A page not created yet: its creation comes first, as it would have online.
    if (uncreated()) {
      let created = await save(draft);
      // The creation's own first text was refused, and given up (the server stored nothing): the page is created with
      // the latest text instead, and the queued versions follow. A refusal of that one is the latest text's.
      if (created.kind === 'rejected' && !created.permanent && uncreated()) created = await save(draft);
      if (created.kind !== 'saved') return created;
      confirm(created.content ?? draft.content, created.draftVersion);
    }

    for (let queued = state.pending[0]; queued !== undefined; queued = state.pending[0]) {
      active = queued;
      try {
        const saved = await save({ content: queued.text, draftVersion });
        if (saved.kind === 'rejected' && !saved.permanent) {
          hold([queued], 'refused');
          continue;
        }
        if (saved.kind === 'failed') return end({ ...saved, unknown: queued.text });
        // A 409 or a deleted document: the machine decides, and the registry holds the versions if it must.
        if (saved.kind !== 'saved') return end(saved);
        confirm(saved.content ?? queued.text, saved.draftVersion);
        const lost = posted.get(queued);
        if (lost !== undefined && lost.draftVersion !== draftVersion) {
          hold([queued], 'unsure');
          continue;
        }
        const revised = await revise(queued, draftVersion);
        if (revised.kind === 'done') remove(queued);
        else if (revised.kind === 'unsure') hold([queued], 'unsure');
        else if (revised.kind === 'rejected' && !revised.permanent) hold([queued], 'refused');
        else if (revised.kind === 'failed') return end({ ...revised, unknown: queued.text });
        else return end(revised);
      } finally {
        active = undefined;
      }
    }

    // The server holds the latest text already: nothing more to send.
    if (confirmed !== undefined && confirmed.content === draft.content) {
      return { kind: 'saved', draftVersion: confirmed.draftVersion };
    }
    return end(await save({ content: draft.content, draftVersion }));
  };

  return {
    enqueue: (version) => {
      const last = state.pending.at(-1);
      if (last?.text !== version.text) {
        set({ ...state, pending: [...state.pending, version] });
        return;
      }
      if (version.name === undefined || version.name === last.name) return;
      // Not sent yet: the name is the version's. Sent already: the version gets it by a rename once created.
      const named: Pending =
        last.name === undefined && last !== active
          ? { text: last.text, name: version.name }
          : { text: last.text, name: version.name, rename: true };
      const pending = named.rename ? [...state.pending, named] : [...state.pending.slice(0, -1), named];
      set({ ...state, pending });
    },
    holdAll: (reason) => hold(state.pending, reason),
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

/**
 * Holds every version still to create as soon as the machine is in conflict or its document is gone: before the writer
 * can resolve the conflict and restart the saves, so that a queued text is never written over another device's draft.
 */
export const holdOnStop = (machine: Pick<Autosave, 'getSnapshot' | 'subscribe'>, queue: VersionQueue): (() => void) =>
  machine.subscribe(() => {
    const state = machine.getSnapshot();
    if (state.status === 'conflict') queue.holdAll('conflict');
    else if (state.status === 'rejected' && state.permanent) queue.holdAll('deleted');
  });
