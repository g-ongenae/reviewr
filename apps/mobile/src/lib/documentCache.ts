import type { Document, DocumentDraft } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { createDrafts, type Drafts, type DraftsOptions } from './drafts';
import { queryKeys } from './queryKeys';

/** The newest draft and head revision the app has seen confirmed for a document. */
interface Newest {
  draft?: DocumentDraft;
  head?: { revision: number; content: string };
}

export interface AppDrafts {
  drafts: Drafts;
  /** The query function of a document: the server's answer, settled against what the app has seen confirmed. */
  fetchDocument: (id: string) => Promise<Document>;
}

/**
 * The drafts of the app, bound to the query cache. One rule for every write of a document to the cache (the query's
 * answer, a saved draft, a version, a reconciliation, a rename): it never takes the document back to a draft or a
 * revision older than the newest this app has seen confirmed for it (`settle`). An answer that started before a newer
 * draft was confirmed is a late one. What was seen outlives the document's entry and its cached query, so a document
 * opened again never shows an older text as saved. The same holds for the title, by the order of the requests.
 */
export const createAppDrafts = (
  queryClient: QueryClient,
  options: Omit<DraftsOptions, 'onDraft' | 'onDocument'>,
): AppDrafts => {
  // One draft and one head per document opened since the app started: the price of telling a late answer apart.
  const newest = new Map<string, Newest>();
  /**
   * The title has no version, so the order of the requests decides: a read that started before a rename of this app
   * was confirmed holds an older title, and takes the confirmed one.
   */
  let requests = 0;
  const renamed = new Map<string, { title: string | null; at: number }>();

  /** Records what an answer confirmed, and answers the newest seen for the document. */
  const see = (id: string, draft?: DocumentDraft, head?: Newest['head']): Newest => {
    const seen = newest.get(id) ?? {};
    const next: Newest = {
      draft: draft !== undefined && draft.draftVersion > (seen.draft?.draftVersion ?? 0) ? draft : seen.draft,
      head: head !== undefined && head.revision > (seen.head?.revision ?? -1) ? head : seen.head,
    };
    newest.set(id, next);
    return next;
  };

  /** What a cache write of `document` leaves: the document, with the newest draft and head seen for it. */
  const settle = (document: Document): Document => {
    const { draft, head } = see(document.id, document.draft, {
      revision: document.revision,
      content: document.content,
    });
    return { ...document, ...head, ...(draft === undefined ? {} : { draft }) };
  };

  const write = (id: string, update: (cached: Document | undefined) => Document | undefined) =>
    queryClient.setQueryData<Document>(queryKeys.document(id), (cached) => {
      const next = update(cached);
      return next === undefined ? undefined : settle(next);
    });

  const drafts = createDrafts({
    ...options,
    onDraft: (id, draft) => {
      see(id, draft);
      write(id, (cached) => cached && { ...cached, draft });
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
    },
    onDocument: (saved, part) => {
      see(saved.id, saved.draft, { revision: saved.revision, content: saved.content });
      if (part === 'title') renamed.set(saved.id, { title: saved.title, at: ++requests });
      // The title comes from renames and reads only: a version's answer cannot tell an older title from a newer one.
      write(saved.id, (cached) =>
        part === 'title'
          ? cached && { ...cached, title: saved.title }
          : { ...saved, title: cached?.title ?? saved.title },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      if (part === 'text') void queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) });
    },
  });

  const fetchDocument = async (id: string): Promise<Document> => {
    const started = ++requests;
    const document = settle(await options.api.getDocument(id));
    const rename = renamed.get(id);
    return rename !== undefined && rename.at > started ? { ...document, title: rename.title } : document;
  };

  return { drafts, fetchDocument };
};
