/**
 * Deleting a document as the writer saw it: the delete carries exactly the pair the screen was showing when the
 * confirmation opened (the head revision and the draft version, from the rendered values), and nothing is flushed or
 * read again afterwards. If anything moved since, on another device or in this app, the server refuses with a 409 and
 * deletes nothing: the writer looks again, and confirms again.
 */
import type { AutosaveState } from './autosave.js';

/** What the screen rendered when the writer asked to delete. */
export interface RenderedDocument {
  /** The autosave state of that render. */
  state: AutosaveState;
  /** The head revision of that render. */
  revision: number;
  /** Whether another write of this editor was running: a version, a merge or "Keep mine", a restore. */
  writing: boolean;
}

/** The pair a delete carries, or why it must not be asked at all (a sentence for the writer). */
export type DeleteDecision = { seen: { revision: number; draftVersion: number } } | { refused: string };

/** Decides, before the confirmation opens, what the delete carries, from what the screen rendered. */
export const deleteAsSeen = ({ state, revision, writing }: RenderedDocument): DeleteDecision => {
  if (writing) {
    return { refused: 'Not deleted: a version, a merge or a restore is in progress. Delete once it has finished.' };
  }
  switch (state.status) {
    case 'saved':
    // A refused text is in no draft: the writer confirms the delete with it on screen, so the delete carries the last
    // draft the server confirmed. A permanent refusal (deleted elsewhere) gets the server's 404, as before.
    // falls through
    case 'rejected':
      return { seen: { revision, draftVersion: state.base.draftVersion } };
    case 'conflict':
      return {
        refused:
          'Not deleted: this document was changed on another device. Resolve that first, then delete it if you still mean to.',
      };
    default:
      return { refused: 'Not deleted: your text is not saved yet. Delete once it is saved.' };
  }
};
