import { deleteAsSeen, type RenderedDocument } from '@reviewr/autosave';

/** The pair a delete carries: the head revision and the draft version the screen showed. */
export interface SeenPair {
  revision: number;
  draftVersion: number;
}

/**
 * What the editor screen does when the writer taps "Delete": it takes the pair from what it rendered, then opens the
 * confirmation. Reads that arrive while the confirmation is open change nothing: "Delete" sends the pair taken before
 * it opened, and the server refuses (409) if the document moved meanwhile. A screen not in a state to delete from asks
 * nothing and says why.
 */
export const askToDelete = (
  rendered: RenderedDocument,
  confirm: (onConfirm: () => void) => void,
  send: (seen: SeenPair) => void,
  refuse: (message: string) => void,
): void => {
  const decision = deleteAsSeen(rendered);
  if ('refused' in decision) {
    refuse(decision.refused);
    return;
  }
  confirm(() => send(decision.seen));
};
