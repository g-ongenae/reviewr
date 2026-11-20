import type { Revision, RevisionSummary } from '@reviewr/shared';
import { describeError, isServerUnreachable } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { versionNameToSend } from './versionName';

export interface RevisionNameApi {
  nameRevision(documentId: string, revision: number, name: string | null): Promise<RevisionSummary>;
}

/** Key of the request naming one revision: one at a time per revision, even across visits of the history. */
export const nameRevisionKey = (revision: Pick<RevisionSummary, 'documentId' | 'revision'>) =>
  ['nameRevision', revision.documentId, revision.revision] as const;

/**
 * Gives a version the name typed, changes it, or clears it when the name is blank, through
 * `PATCH /documents/:id/revisions/:n`. The history then shows the server's answer: the list and the revision read for
 * its preview take the new name, every other row stays, and the text is not touched. A failed rename rejects and
 * changes nothing: the list keeps the old name. Nothing is queued while the server is unreachable.
 */
export const renameRevision = async (
  queryClient: QueryClient,
  api: RevisionNameApi,
  revision: Pick<RevisionSummary, 'documentId' | 'revision'>,
  value: string,
): Promise<RevisionSummary> => {
  const saved = await api.nameRevision(revision.documentId, revision.revision, versionNameToSend(value) ?? null);
  const listKey = queryKeys.revisions(saved.documentId);
  const fullKey = queryKeys.revision(saved.documentId, saved.revision);
  // A read sent before this answer may still hold the old name: drop it, so it cannot put the old name back.
  await queryClient.cancelQueries({ queryKey: listKey, exact: true });
  await queryClient.cancelQueries({ queryKey: fullKey, exact: true });
  queryClient.setQueryData<RevisionSummary[]>(listKey, (list) =>
    list?.map((item) => (item.revision === saved.revision ? { ...item, ...saved } : item)),
  );
  queryClient.setQueryData<Revision>(fullKey, (full) => (full === undefined ? undefined : { ...full, ...saved }));
  // Read both again, so that what the dropped reads would have brought (a version saved meanwhile) still shows.
  void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
  void queryClient.invalidateQueries({ queryKey: fullKey, exact: true });
  return saved;
};

/** What the history says under the field when a rename failed; what was typed stays in the field. */
export const renameError = (error: unknown): string =>
  isServerUnreachable(error)
    ? 'Name not saved: the server is unreachable. Try again once it is back.'
    : `Name not saved: ${describeError(error)}`;

/** How a version reads in the history: its name first when it has one, its number underneath. */
export const revisionLabel = (
  revision: Pick<RevisionSummary, 'revision' | 'name'>,
): { heading: string; number?: string } => {
  const number = `Revision ${revision.revision}`;
  return revision.name === null ? { heading: number } : { heading: revision.name, number };
};
