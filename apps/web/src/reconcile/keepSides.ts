import type { Document } from '@reviewr/shared';
import { api, isConflict } from '../api';
import type { Draft } from '../autosave/autosave';
import { draftOf } from '../autosave/useAutosave';

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** The name of a version a reconciliation keeps: the side its text comes from, and the day ("This device — 13 Nov"). */
export const versionName = (side: 'mine' | 'theirs', date: Date): string =>
  `${side === 'mine' ? 'This device' : 'Other device'} — ${day.format(date)}`;

/** The three texts of a confirmed reconciliation. */
export interface Sides {
  /** The local text. */
  mine: string;
  /** The other device's draft, the one the writer reconciled with. */
  theirs: string;
  /** What the writer confirmed. */
  result: string;
}

export type KeepOutcome =
  /** Every text the result replaces is in the history; `confirmed` is the server's draft to save the result on. */
  | { kind: 'kept'; confirmed: Draft; document: Document }
  /** The server's draft moved to another text: `document` holds it, to reconcile with. */
  | { kind: 'moved'; document: Document };

/**
 * Before a reconciled text replaces the draft, keeps in the history, as named versions, each text it would erase: the
 * other device's draft, then the local text, when they differ from the result and are not the head already. A version
 * only snapshots the server's draft, so the local text is saved as the draft first.
 *
 * It starts from the server's document and skips what is already done, so a retry after a failure keeps nothing
 * twice: a draft that holds the local text is this sequence's own write, and a text that is the head is kept.
 * Rejects when a request fails; a 409 (the server moved meanwhile) is answered as `moved`.
 */
export const keepSides = async (id: string, sides: Sides, now: Date): Promise<KeepOutcome> => {
  let document = await api.getDocument(id);
  const draft = () => draftOf(document);
  if (draft().content !== sides.theirs && draft().content !== sides.mine) return { kind: 'moved', document };

  /** Makes the server's draft a version: a no-op on the server when it already is the head. */
  const snapshot = async (side: 'mine' | 'theirs') => {
    document = await api.createRevision(id, {
      name: versionName(side, now),
      draftVersion: draft().draftVersion,
      baseRevision: document.revision,
    });
  };

  try {
    if (draft().content === sides.theirs && sides.theirs !== sides.result && sides.theirs !== document.content) {
      await snapshot('theirs');
    }
    if (sides.mine !== sides.result && sides.mine !== document.content) {
      if (draft().content !== sides.mine) {
        const saved = await api.saveDraft(id, { content: sides.mine, draftVersion: draft().draftVersion });
        document = { ...document, draft: saved };
      }
      await snapshot('mine');
    }
  } catch (error) {
    if (!isConflict(error)) throw error;
    return { kind: 'moved', document: await api.getDocument(id) };
  }
  return { kind: 'kept', confirmed: draft(), document };
};
