import type { Autosave } from '@reviewr/autosave';
import type { DeleteDocumentInput } from '@reviewr/shared';
import { conflictOf } from '@reviewr/shared';

/** The delete was not sent: the text on screen could not be saved first, so what the server holds is unknown. */
export const textNotSaved = new Error('Not deleted: your text could not be saved first. Delete again once it is saved.');

/** The delete was not sent: a version being saved moves the head, and the delete would refuse it as a change. */
export const versionSaving = new Error('Not deleted: a version is being saved. Delete again once it is saved.');

export interface DeleteAsSeenOptions {
  /** The document's autosave: its text is saved first, and the delete carries the draft it last confirmed. */
  autosave: Pick<Autosave, 'flush' | 'getSnapshot'>;
  /** The head revision the screen shows, read once the text is saved. */
  revision: () => number;
  /** Whether "Save version" is running. */
  savingVersion: boolean;
  deleteDocument: (seen: DeleteDocumentInput) => Promise<void>;
}

/**
 * Deletes a document as the screen saw it: the head revision it shows and the draft the server last confirmed to this
 * app. A save waiting or in flight is sent first, so the delete never runs into this app's own save; when that save
 * fails, or while a version is being saved, nothing is sent. A document changed elsewhere since is not deleted: the
 * server answers 409 `document_changed` (see `changedElsewhere`).
 */
export const deleteAsSeen = async ({
  autosave,
  revision,
  savingVersion,
  deleteDocument,
}: DeleteAsSeenOptions): Promise<void> => {
  if (savingVersion) throw versionSaving;
  const flushed = await autosave.flush();
  if (flushed === 'failed' || flushed === 'disposed') throw textNotSaved;
  // On a conflict or a refused text, the confirmed draft is still what the server last said: the server decides.
  await deleteDocument({ revision: revision(), draftVersion: autosave.getSnapshot().base.draftVersion });
};

/** Whether a delete was refused because the document changed elsewhere: then it is read again, and nothing was deleted. */
export const changedElsewhere = (error: unknown): boolean => conflictOf(error)?.code === 'document_changed';
