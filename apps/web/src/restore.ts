/**
 * "Restore into editor" from the history: an old version's title and text replace the ones on screen, as an edit. A
 * text on screen that is in no version (not the head revision's text) is first kept as a version named "Before
 * restore"; when it cannot be, nothing is restored and the text stays as it is.
 *
 * The mobile app has the same rule in `apps/mobile/src/lib/drafts.ts` (`restore`); the two are to be shared later.
 */
import type { CreateRevisionInput, Document } from '@reviewr/shared';
import { conflictOf } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { inlineError, queryKeys } from './api';
import type { Autosave, AutosaveState } from './autosave/autosave';
import { draftOf, isGone } from './autosave/useAutosave';

/** The text on screen changed while it was being kept: the version would not hold the text the restore replaces. */
export const textMoved = new Error('The text changed during the restore');

/** Why a restore is not even tried: a conflict, a merge being saved, or a deleted document holds the text. */
export type RestoreRefusal = 'conflict' | 'busy' | 'deleted';

export type RestoreOutcome =
  | { kind: 'restored' }
  | { kind: 'refused'; reason: RestoreRefusal }
  /** The text on screen could not be kept as a version: nothing was restored. */
  | { kind: 'failed'; error: unknown };

export interface RestoreOptions {
  autosave: Autosave;
  /** The head revision as the editor knows it. A text equal to its text is in a version already. */
  head: { revision: number; content: string };
  /** Whether a merged text is being saved now. */
  busy: () => boolean;
  /** Whether the document is known to be deleted. */
  gone: () => boolean;
  createRevision: (input: CreateRevisionInput) => Promise<Document>;
  /** The version that keeps the text on screen was saved: called with the server's answer, before the restore. */
  onKept: (saved: Document) => void;
  /** Puts the old version's title and text in the editor; called only once the text on screen is safe. */
  apply: () => void;
  now?: () => Date;
}

/** Names the version a restore keeps by its day, as the mobile app and `versionName` of `@reviewr/reconcile` do. */
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export const beforeRestoreName = (date: Date): string => `Before restore — ${day.format(date)}`;

/** Why the text on screen cannot be replaced now, if it cannot. */
export const restoreRefusal = (state: AutosaveState, busy: boolean, gone: boolean): RestoreRefusal | undefined => {
  if (gone || (state.status === 'rejected' && state.permanent)) return 'deleted';
  if (busy) return 'busy';
  if (state.status === 'conflict') return 'conflict';
  return undefined;
};

const refusalOf = ({ autosave, busy, gone }: RestoreOptions) => restoreRefusal(autosave.getSnapshot(), busy(), gone());

/**
 * Saves the text on screen, `text`, as a version: the draft first, then the draft as a revision. Undefined once it is
 * kept; otherwise the outcome that stops the restore.
 */
const keep = async (options: RestoreOptions, text: string): Promise<RestoreOutcome | undefined> => {
  const { autosave, head, createRevision, now = () => new Date() } = options;
  const flushed = await autosave.flush();
  if (flushed !== 'saved') {
    const refusal = refusalOf(options);
    if (refusal !== undefined) return { kind: 'refused', reason: refusal };
    const state = autosave.getSnapshot();
    return {
      kind: 'failed',
      error: state.status === 'retrying' || state.status === 'rejected' ? state.error : undefined,
    };
  }
  // The flush may end on a later text, typed during the restore and sent along with it.
  const { draftVersion, content: confirmed } = autosave.getSnapshot().base;
  if (confirmed !== text) return { kind: 'failed', error: textMoved };
  let baseRevision = head.revision;
  // The head moved elsewhere, not the draft: that version stays in the history, and the draft is saved over it.
  for (let attempt = 1; ; attempt++) {
    try {
      const saved = await createRevision({
        name: beforeRestoreName(now()),
        draftVersion,
        baseRevision: baseRevision === 0 ? null : baseRevision,
      });
      options.onKept(saved);
      return undefined;
    } catch (error) {
      const conflict = conflictOf(error);
      if (conflict?.code === 'stale_revision' && attempt < 3) {
        baseRevision = conflict.revision;
        continue;
      }
      if (conflict?.code === 'draft_conflict') {
        // The local text stays, and is a conflict unless the draft holds it (then this tab's autosave moved it).
        autosave.refresh(conflict.draft, true);
        if (autosave.getSnapshot().status === 'conflict') return { kind: 'refused', reason: 'conflict' };
        return { kind: 'failed', error: textMoved };
      }
      return { kind: 'failed', error };
    }
  }
};

/**
 * Restores an old version into the editor (`apply`). When the text on screen is the head's, it is replaced at once,
 * before this returns its promise; otherwise it is first kept as a version, and replaced only if that worked and the
 * text did not change meanwhile.
 */
export const restore = async (options: RestoreOptions): Promise<RestoreOutcome> => {
  const { autosave, head } = options;
  const refusal = refusalOf(options);
  if (refusal !== undefined) return { kind: 'refused', reason: refusal };
  const text = autosave.getSnapshot().content;
  if (text !== head.content) {
    const stopped = await keep(options, text);
    if (stopped !== undefined) return stopped;
    const after = refusalOf(options);
    if (after !== undefined) return { kind: 'refused', reason: after };
    // Typed after the version was saved: that text is in no version, and is never replaced silently.
    if (autosave.getSnapshot().content !== text) return { kind: 'failed', error: textMoved };
  }
  options.apply();
  return { kind: 'restored' };
};

/** What the history says when nothing was restored; undefined after a restore. */
export const restoreMessage = (outcome: RestoreOutcome): string | undefined => {
  switch (outcome.kind) {
    case 'restored':
      return undefined;
    case 'refused':
      switch (outcome.reason) {
        case 'conflict':
          return 'Not restored: this text was also changed on another device. Resolve that first; your text is kept as it is.';
        case 'busy':
          return 'Not restored: a merged text is being saved. Try again once it is saved.';
        case 'deleted':
          return 'Not restored: this document was deleted elsewhere. Your text is kept as it is.';
      }
      break;
    case 'failed': {
      if (outcome.error === textMoved) {
        return 'Not restored: your text changed during the restore. It is kept as it is: restore again to replace it.';
      }
      const detail = inlineError(outcome.error) ?? 'the server is unreachable';
      return `Not restored: your current text could not be kept as a version first (${detail}). It is still in the editor.`;
    }
  }
};

/**
 * The version a restore kept: it goes in the cache and to the autosave, as a version saved with "Save version" does.
 * The answer may be older than a draft saved or a rename confirmed since: those stay, and the title is never taken
 * from it.
 */
export const cacheKeptVersion = (queryClient: QueryClient, autosave: Autosave, saved: Document) => {
  if (!isGone(queryClient, saved.id)) {
    queryClient.setQueryData<Document>(queryKeys.document(saved.id), (cached) => {
      if (cached === undefined) return saved;
      if (cached.revision > saved.revision) return cached;
      const newerDraft = (cached.draft?.draftVersion ?? 0) > (saved.draft?.draftVersion ?? 0);
      return { ...saved, title: cached.title, draft: newerDraft ? cached.draft : saved.draft };
    });
  }
  autosave.refresh(draftOf(saved));
  void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) });
};
