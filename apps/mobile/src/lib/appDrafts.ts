import type { Document } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { api, queryKeys, reachability } from './api';
import { createDrafts, type Drafts } from './drafts';

const registries = new WeakMap<QueryClient, Drafts>();

/** The drafts of the app's open documents, one registry per query client, whose cache follows what they save. */
export const draftsOf = (queryClient: QueryClient): Drafts => {
  let drafts = registries.get(queryClient);
  if (drafts !== undefined) return drafts;
  drafts = createDrafts({
    api,
    report: reachability,
    onDraft: (id, draft) => {
      queryClient.setQueryData<Document>(queryKeys.document(id), (cached) =>
        cached === undefined || (cached.draft?.draftVersion ?? 0) >= draft.draftVersion ? cached : { ...cached, draft },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
    },
    onDocument: (saved, part) => {
      // The answer may be older than a draft saved or a rename confirmed since the request started: those stay.
      queryClient.setQueryData<Document>(queryKeys.document(saved.id), (cached) => {
        if (cached === undefined) return part === 'text' ? saved : undefined;
        if (part === 'title') return { ...cached, title: saved.title };
        if (cached.revision > saved.revision) return cached;
        const newerDraft = (cached.draft?.draftVersion ?? 0) > (saved.draft?.draftVersion ?? 0);
        return { ...saved, title: cached.title, draft: newerDraft ? cached.draft : saved.draft };
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      if (part === 'text') void queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) });
    },
  });
  registries.set(queryClient, drafts);
  return drafts;
};
