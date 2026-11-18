/**
 * Deleting a document as the writer saw it. One rule, the same in every app: from the confirmation to the answer, the
 * editor writes nothing except the save of the text the writer was looking at, and the delete carries the head the
 * screen showed at the confirmation, with the draft version of that text. The server deletes only if neither moved
 * since (a 409 otherwise), so a delete made from a stale screen never destroys text saved elsewhere.
 *
 * The app freezes its editor while the delete is pending (no edit, no version, no restore, no merge), so nothing is
 * typed after the confirmation, and a successful delete discards nothing the writer did not see.
 */
import type { Autosave } from './autosave.js';

/** Why a delete was refused before anything was sent. */
export type DeleteRefusal = 'busy' | 'conflict' | 'notSaved';

const refusalMessages: Record<DeleteRefusal, string> = {
  busy: 'Not deleted: a version, a merge or a restore is in progress. Delete again once it has finished.',
  conflict:
    'Not deleted: this document was changed on another device. Resolve that first, then delete it if you still mean to.',
  notSaved: 'Not deleted: your text could not be saved first. Delete again once it is saved.',
};

/** A delete that was not sent. Its message is what the writer is told. */
export class DeleteRefused extends Error {
  public readonly reason: DeleteRefusal;

  /**
   * @param reason - Why nothing was sent
   */
  constructor(reason: DeleteRefusal) {
    super(refusalMessages[reason]);
    this.name = 'DeleteRefused';
    this.reason = reason;
  }
}

/** What the screen showed when the writer confirmed the delete. */
export interface DeleteCapture {
  /** The head revision the screen rendered. */
  revision: number;
  /** The text on screen. */
  text: string;
  /** The draft version of that text, when the server had already confirmed it (or refused a newer one). */
  draftVersion?: number;
  /** Set when the delete must not be sent at all. */
  refusal?: DeleteRefusal;
}

/**
 * Takes what the delete will carry, when the confirmation callback runs. `revision` is the head the screen rendered,
 * never one read later; `busy` says whether another write of this editor runs (a version, a merge, a restore).
 */
export const captureDelete = (
  autosave: Pick<Autosave, 'getSnapshot'>,
  revision: number,
  busy: boolean,
): DeleteCapture => {
  const state = autosave.getSnapshot();
  const capture: DeleteCapture = { revision, text: state.content };
  if (busy) {
    return { ...capture, refusal: 'busy' };
  }
  if (state.status === 'conflict') {
    return { ...capture, refusal: 'conflict' };
  }
  // A refused text is in no draft: the writer confirmed the delete with it on screen, so the delete carries the last
  // draft the server confirmed. A permanent refusal (deleted elsewhere) gets the server's 404, as before.
  if (state.status === 'saved' || state.status === 'rejected') {
    return { ...capture, draftVersion: state.base.draftVersion };
  }

  return capture;
};

/**
 * Sends the delete of a capture. A text not confirmed yet (waiting, in flight, retrying) is saved first, once: only an
 * answer `saved` for that very text lets the delete go, with the version the server gave it; anything else (a failure,
 * a conflict that appeared, the editor gone) sends nothing. Rejects with `DeleteRefused` when nothing was sent, or
 * with the error of `deleteDocument`.
 */
export const deleteAsSeen = async (
  autosave: Pick<Autosave, 'flush' | 'getSnapshot'>,
  capture: DeleteCapture,
  deleteDocument: (seen: { revision: number; draftVersion: number }) => Promise<void>,
): Promise<void> => {
  if (capture.refusal !== undefined) {
    throw new DeleteRefused(capture.refusal);
  }
  let { draftVersion } = capture;
  if (draftVersion === undefined) {
    if ((await autosave.flush()) !== 'saved') {
      throw new DeleteRefused('notSaved');
    }
    const { base } = autosave.getSnapshot();
    // The server confirmed another text than the one on screen at the confirmation: it is not the text the writer saw.
    if (base.content !== capture.text) {
      throw new DeleteRefused('notSaved');
    }
    draftVersion = base.draftVersion;
  }
  await deleteDocument({ revision: capture.revision, draftVersion });
};
