import type { QueryClient } from '@tanstack/react-query';
import { api, reachability } from './api';
import { createAppDrafts, type AppDrafts } from './documentCache';

const registries = new WeakMap<QueryClient, AppDrafts>();

/** The drafts of the app's open documents, one registry per query client, bound to its cache. */
const appDraftsOf = (queryClient: QueryClient): AppDrafts => {
  let app = registries.get(queryClient);
  if (app === undefined) {
    app = createAppDrafts(queryClient, { api, report: reachability });
    registries.set(queryClient, app);
  }
  return app;
};

export const draftsOf = (queryClient: QueryClient) => appDraftsOf(queryClient).drafts;

/** The query function of a document: every screen reads it through here (see `createAppDrafts`). */
export const fetchDocument = (queryClient: QueryClient, id: string) => appDraftsOf(queryClient).fetchDocument(id);
