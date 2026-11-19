import type { Document, DocumentDraft } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { api, isNotFound, queryKeys } from './api';

/**
 * One rule for every write of a document to the query cache (a read's answer, a saved draft, a version, a merge, a
 * restore, a rename): it never takes the document back to a draft or a head revision older than the newest this tab
 * has seen confirmed for it. An answer that started before a newer one was confirmed is a late one. What was seen
 * outlives the document's machine and its cached query, so a document opened again never starts from an older text.
 * The title has no version: the order of the requests decides (see `readDocument`).
 *
 * The same rule as the phone's `documentCache`, ported: both apps may share it later.
 */

/**
 * The newest draft, head revision and confirmed rename this tab has seen for one incarnation of a document: the one
 * created at `createdAt`. An id can come back as another document (deleted, then created again under it): that one has
 * a later `createdAt`, and its counters start over, so they say nothing against the record of the deleted one.
 */
interface Newest {
  createdAt: string;
  draft?: DocumentDraft;
  head?: { revision: number; content: string };
  rename?: { title: string | null; at: number };
}

interface Seen {
  newest: Map<string, Newest>;
  /** Numbers reads and confirmed renames in the order they happened. */
  requests: number;
}

/** One record per query client, so each test starts empty. One record per document read since. */
const seenBy = new WeakMap<QueryClient, Seen>();

const seenOf = (queryClient: QueryClient): Seen => {
  let seen = seenBy.get(queryClient);
  if (seen === undefined) {
    seen = { newest: new Map(), requests: 0 };
    seenBy.set(queryClient, seen);
  }
  return seen;
};

/** The newer of two drafts: the higher counter; at the same counter, the later base (a version made from it). */
const newerDraft = (draft: DocumentDraft, seen: DocumentDraft | undefined): boolean =>
  seen === undefined ||
  draft.draftVersion > seen.draftVersion ||
  (draft.draftVersion === seen.draftVersion && (draft.baseRevision ?? 0) > (seen.baseRevision ?? 0));

/**
 * The document, with the newest draft and head seen for it, its own counting as seen. An answer from a later
 * incarnation starts a new record. One from an earlier incarnation (a read answered after the document was deleted
 * and created again, and read since) is a late one: it takes the text of the newest incarnation; only its title (and
 * its other fields) stays until the next read.
 */
const settle = (queryClient: QueryClient, document: Document): Document => {
  const { newest } = seenOf(queryClient);
  const { createdAt } = document;
  const record = newest.get(document.id);
  const incarnation = record === undefined ? 1 : Math.sign(Date.parse(createdAt) - Date.parse(record.createdAt));
  if (record === undefined || incarnation > 0) {
    const fresh: Newest = {
      createdAt,
      draft: document.draft,
      head: { revision: document.revision, content: document.content },
    };
    newest.set(document.id, fresh);
    return document;
  }
  if (incarnation === 0) {
    if (document.draft !== undefined && newerDraft(document.draft, record.draft)) record.draft = document.draft;
    if (record.head === undefined || document.revision > record.head.revision) {
      record.head = { revision: document.revision, content: document.content };
    }
  }
  const { draft, head } = record;
  return {
    ...document,
    createdAt: record.createdAt,
    ...head,
    ...(draft === undefined ? {} : { draft }),
  };
};

/**
 * A draft the server confirmed: no cache write may go back under it. It belongs to the incarnation this tab has seen,
 * the cached one if it has no record yet.
 */
export const seeDraft = (queryClient: QueryClient, id: string, draft: DocumentDraft) => {
  const { newest } = seenOf(queryClient);
  const cached = queryClient.getQueryData<Document>(queryKeys.document(id));
  if (!newest.has(id) && cached !== undefined) settle(queryClient, cached);
  const record = newest.get(id);
  if (record !== undefined && newerDraft(draft, record.draft)) record.draft = draft;
};

/** The document is gone (a read answered 404, or this tab deleted it): its record goes. */
export const forgetDocumentSeen = (queryClient: QueryClient, id: string) => {
  seenOf(queryClient).newest.delete(id);
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
  settle(queryClient, saved);
  const record = seen.newest.get(saved.id);
  if (record?.createdAt === saved.createdAt) record.rename = { title: saved.title, at: ++seen.requests };
  writeDocument(queryClient, saved.id, (cached) => cached && { ...cached, title: saved.title });
};

/**
 * Reads the document: the server's answer, settled on the newest draft and head seen, and with the title of a rename
 * of that incarnation confirmed after the read started. The query function of a document, and every other read of
 * one. A 404 drops the record.
 */
export const readDocument = async (queryClient: QueryClient, id: string): Promise<Document> => {
  const seen = seenOf(queryClient);
  const started = ++seen.requests;
  let answer: Document;
  try {
    answer = await api.getDocument(id);
  } catch (error) {
    if (isNotFound(error)) forgetDocumentSeen(queryClient, id);
    throw error;
  }
  const document = settle(queryClient, answer);
  // A rename of the newest incarnation confirmed since the read started: the answer's title is older.
  const rename = seen.newest.get(id)?.rename;
  return rename !== undefined && rename.at > started ? { ...document, title: rename.title } : document;
};
