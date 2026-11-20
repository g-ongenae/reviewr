import type { ConflictBody, CreateRevisionInput, DraftConflictBody } from '@reviewr/shared';
import { isServerUnreachable } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { newDocumentId } from './autosave/useAutosave';

/**
 * "Save version" requests whose answer was lost (the server was unreachable), by document: the version may exist.
 * Only the last one is kept, in memory: a reload forgets it.
 */
const lostRequests = new WeakMap<QueryClient, Map<string, CreateRevisionInput>>();

const lostOf = (queryClient: QueryClient): Map<string, CreateRevisionInput> => {
  let lost = lostRequests.get(queryClient);
  if (lost === undefined) {
    lost = new Map();
    lostRequests.set(queryClient, lost);
  }
  return lost;
};

/**
 * The "Save version" request to send for `input`, with an idempotency key. The request whose answer was lost is sent
 * again as it was, key and `baseRevision` included, when it saves the same draft (`draftVersion`) under the same name:
 * the server then answers the revision it already made, whatever moved since. Any other request takes a new key.
 */
export const versionRequest = (
  queryClient: QueryClient,
  id: string,
  input: Omit<CreateRevisionInput, 'idempotencyKey'>,
): CreateRevisionInput => {
  const lost = lostOf(queryClient).get(id);
  if (lost?.draftVersion === input.draftVersion && (lost.name ?? null) === (input.name ?? null)) return lost;
  return { ...input, idempotencyKey: newDocumentId() };
};

/**
 * The request `input` ended: kept when its answer was lost (`error` from an unreachable server), forgotten on any
 * answer, success or refusal. Its key is then never sent again: the server decided, and another request with the same
 * key would be refused.
 */
export const settleVersionRequest = (
  queryClient: QueryClient,
  id: string,
  input: CreateRevisionInput,
  error?: unknown,
) => {
  if (error !== undefined && isServerUnreachable(error)) lostOf(queryClient).set(id, input);
  else lostOf(queryClient).delete(id);
};

/**
 * Whether a version request refused as `conflict` can be sent again on the server's draft: the draft moved past
 * `draftVersion`, the counter the request was sent on, yet holds exactly `text`, the text the version is asked for.
 * Only the counter moved: a draft save of the same text elsewhere, a request of this device given up then applied, or
 * another device that changed the text and came back to it. Any other text is a real conflict, never saved over.
 *
 * The mobile app needs the same rule; it could live in `@reviewr/shared` later.
 */
export const sameTextMoved = (
  conflict: ConflictBody | undefined,
  text: string,
  draftVersion: number,
): conflict is DraftConflictBody =>
  conflict?.code === 'draft_conflict' && conflict.draft.content === text && conflict.draft.draftVersion > draftVersion;
