import type { Document, DocumentDraft } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { api, queryKeys } from './api';

/**
 * One rule for every write of a document to the query cache (a read's answer, a saved draft, a version, a merge, a
 * restore, a rename): it never takes the document back to a draft or a head revision older than the newest this tab
 * has seen confirmed for it. An answer that started before a newer one was confirmed is a late one. What was seen
 * outlives the document's machine and its cached query, so a document opened again never starts from an older text.
 * The title has no version: the order of the requests decides (see `readDocument`).
 *
 * The same rule as the phone's `documentCache`, ported: both apps may share it later.
 */

/** The newest draft and head revision this tab has seen confirmed for a document. */
interface Newest {
  draft?: DocumentDraft;
  head?: { revision: number; content: string };
}

interface Seen {
  newest: Map<string, Newest>;
  /** Numbers reads and confirmed renames in the order they happened. */
  requests: number;
  renamed: Map<string, { title: string | null; at: number }>;
}

/** One record per query client, so each test starts empty. One draft and one head per document read since. */
const seenBy = new WeakMap<QueryClient, Seen>();

const seenOf = (queryClient: QueryClient): Seen => {
  let seen = seenBy.get(queryClient);
  if (seen === undefined) {
    seen = { newest: new Map(), requests: 0, renamed: new Map() };
    seenBy.set(queryClient, seen);
  }
  return seen;
};

/** Records what an answer confirmed, and answers the newest seen for the document. */
const see = (queryClient: QueryClient, id: string, draft?: DocumentDraft, head?: Newest['head']): Newest => {
  const { newest } = seenOf(queryClient);
  const seen = newest.get(id) ?? {};
  const next: Newest = {
    draft: draft !== undefined && draft.draftVersion > (seen.draft?.draftVersion ?? 0) ? draft : seen.draft,
    head: head !== undefined && head.revision > (seen.head?.revision ?? -1) ? head : seen.head,
  };
  newest.set(id, next);
  return next;
};

/** The document, with the newest draft and head seen for it (its own counting as seen). */
const settle = (queryClient: QueryClient, document: Document): Document => {
  const { draft, head } = see(queryClient, document.id, document.draft, {
    revision: document.revision,
    content: document.content,
  });
  return { ...document, ...head, ...(draft === undefined ? {} : { draft }) };
};

/** A draft the server confirmed: no cache write may go back under it. */
export const seeDraft = (queryClient: QueryClient, id: string, draft: DocumentDraft) => {
  see(queryClient, id, draft);
};

/** Writes the document `id` to the cache through `update`, settled on the newest draft and head seen. */
export const writeDocument = (
  queryClient: QueryClient,
  id: string,
  update: (cached: Document | undefined) => Document | undefined,
) =>
  queryClient.setQueryData<Document>(queryKeys.document(id), (cached) => {
    const next = update(cached);
    return next === undefined ? undefined : settle(queryClient, next);
  });

/**
 * A rename the server confirmed: a read that started before holds an older title, and takes this one. Only the title
 * goes in the cache: the answer's draft may be older than one saved since.
 */
export const cacheRename = (queryClient: QueryClient, saved: Document) => {
  const seen = seenOf(queryClient);
  seen.renamed.set(saved.id, { title: saved.title, at: ++seen.requests });
  settle(queryClient, saved);
  writeDocument(queryClient, saved.id, (cached) => cached && { ...cached, title: saved.title });
};

/**
 * Reads the document: the server's answer, settled on the newest draft and head seen, and with the title of a rename
 * confirmed after the read started. The query function of a document, and every other read of one.
 */
export const readDocument = async (queryClient: QueryClient, id: string): Promise<Document> => {
  const seen = seenOf(queryClient);
  const started = ++seen.requests;
  const document = settle(queryClient, await api.getDocument(id));
  const rename = seen.renamed.get(id);
  return rename !== undefined && rename.at > started ? { ...document, title: rename.title } : document;
};
