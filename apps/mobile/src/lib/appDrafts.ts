import type { QueryClient } from '@tanstack/react-query';
import { api, reachability } from './api';
import { deviceLocalBuffer } from './deviceLocalBuffer';
import { createAppDrafts, type AppDrafts } from './documentCache';
import type { LocalCopy } from './localCopy';

const registries = new WeakMap<QueryClient, AppDrafts>();

/**
 * The drafts of the app's open documents, one registry per query client, bound to its cache and to the phone's local
 * buffer, which is read as soon as the registry exists.
 */
const appDraftsOf = (queryClient: QueryClient): AppDrafts => {
  let app = registries.get(queryClient);
  if (app === undefined) {
    app = createAppDrafts(queryClient, { api, report: reachability, buffer: deviceLocalBuffer() });
    registries.set(queryClient, app);
  }
  return app;
};

export const draftsOf = (queryClient: QueryClient) => appDraftsOf(queryClient).drafts;

/** The query function of a document: every screen reads it through here (see `createAppDrafts`). */
export const fetchDocument = (queryClient: QueryClient, id: string) => appDraftsOf(queryClient).fetchDocument(id);

/** The phone's copy of the texts being written, for the notice that says when it cannot be kept. */
export const localCopyOf = (queryClient: QueryClient): LocalCopy | undefined => appDraftsOf(queryClient).copy;
