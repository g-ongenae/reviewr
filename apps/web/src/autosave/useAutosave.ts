import type { Document, DocumentDraft, DocumentSummary } from '@reviewr/shared';
import { ApiError, conflictOf } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, queryKeys, reachability } from '../api';
import { createAutosave, type Autosave, type AutosaveState, type Draft, type SaveResult } from './autosave';

/**
 * The draft an editor opens on. The API always sends it; documents without one (fixtures written before drafts
 * existed) open on their last version.
 */
export const draftOf = (document: Document): Draft => {
  const { content, draftVersion } = document.draft ?? { content: document.content, draftVersion: 1 };
  return { content, draftVersion };
};

/** 4xx statuses a later attempt can still get through: everything else in 4xx is refused for good. */
const retryableClientErrors = new Set([408, 425, 429]);

/**
 * What a failed `saveDraft` means for the autosave: the other device's draft on a draft conflict, `rejected` when a
 * retry cannot help (the document was deleted, the request is invalid), `failed` otherwise (network, 5xx).
 */
export const toSaveResult = (error: unknown): SaveResult => {
  const conflict = conflictOf(error);
  if (conflict?.code === 'draft_conflict') {
    const { content, draftVersion } = conflict.draft;
    return { kind: 'conflict', server: { content, draftVersion } };
  }
  if (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !retryableClientErrors.has(error.status)
  ) {
    return { kind: 'rejected', error };
  }
  return { kind: 'failed', error };
};

/** Puts a saved draft in the cache, so reopening the document shows it, and moves the document up the list. */
const cacheDraft = (queryClient: QueryClient, id: string, draft: DocumentDraft) => {
  const updatedAt = new Date().toISOString();
  queryClient.setQueryData<Document>(
    queryKeys.document(id),
    (document) => document && { ...document, draft, updatedAt },
  );
  queryClient.setQueryData<DocumentSummary[]>(queryKeys.documents, (list) => {
    const summary = list?.find((item) => item.id === id);
    return summary === undefined ? list : [{ ...summary, updatedAt }, ...(list ?? []).filter((item) => item.id !== id)];
  });
};

interface Entry {
  autosave: Autosave;
  /** Editors showing this machine. */
  users: number;
}

/**
 * The machines of the open documents, one per document. A machine outlives its editor until its text is saved, so
 * leaving a document never drops what was typed. One registry per query client, so each test starts empty.
 */
const registries = new WeakMap<QueryClient, Map<string, Entry>>();

const registryOf = (queryClient: QueryClient): Map<string, Entry> => {
  let registry = registries.get(queryClient);
  if (registry === undefined) {
    registry = new Map();
    registries.set(queryClient, registry);
  }
  return registry;
};

const entryFor = (queryClient: QueryClient, document: Document): Entry => {
  const registry = registryOf(queryClient);
  const existing = registry.get(document.id);
  if (existing !== undefined) return existing;

  const { id } = document;
  const autosave = createAutosave({
    base: draftOf(document),
    save: async (draft) => {
      try {
        const saved = await api.saveDraft(id, draft);
        reachability.reportSuccess();
        cacheDraft(queryClient, id, saved);
        return { kind: 'saved', draftVersion: saved.draftVersion };
      } catch (error) {
        reachability.reportError(error);
        return toSaveResult(error);
      }
    },
  });
  const entry = { autosave, users: 0 };
  registry.set(id, entry);
  return entry;
};

/** An editor shows the machine: it is kept until every editor left. */
const acquire = (entry: Entry) => {
  entry.users++;
};

/**
 * An editor left the document: save now, and drop the machine once its text is saved. It keeps retrying meanwhile.
 * After a conflict or a rejection it stays, so reopening the document shows the text and the choice again.
 */
const release = (queryClient: QueryClient, id: string, entry: Entry) => {
  entry.users--;
  // Deferred, so an editor mounted again right away (React's strict mode, a remount) keeps the same machine.
  queueMicrotask(() => {
    if (entry.users > 0) return;
    const { autosave } = entry;
    void autosave.flush();
    const check = () => {
      const { status } = autosave.getSnapshot();
      if (entry.users > 0 || status === 'conflict' || status === 'rejected') {
        unsubscribe();
      } else if (status === 'saved') {
        const registry = registryOf(queryClient);
        if (registry.get(id) === entry) registry.delete(id);
        autosave.dispose();
      }
    };
    const unsubscribe = autosave.subscribe(check);
    check();
  });
};

export interface UseAutosave {
  autosave: Autosave;
  state: AutosaveState;
  /** Drops the machine without saving, for a document that no longer exists. */
  discard: () => void;
}

/**
 * The autosave of an open document: the editor shows `state.content` and sends every edit to `autosave`. Hiding the
 * tab or closing the page saves at once.
 */
export const useAutosave = (document: Document): UseAutosave => {
  const queryClient = useQueryClient();
  const [entry] = useState(() => entryFor(queryClient, document));
  const { autosave } = entry;
  const subscribe = useCallback((listener: () => void) => autosave.subscribe(listener), [autosave]);
  const getSnapshot = useCallback(() => autosave.getSnapshot(), [autosave]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    acquire(entry);
    return () => release(queryClient, document.id, entry);
  }, [queryClient, document.id, entry]);

  useEffect(() => {
    const flush = () => void autosave.flush();
    const onVisibilityChange = () => {
      if (window.document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [autosave]);

  const discard = () => {
    registryOf(queryClient).delete(document.id);
    autosave.dispose();
  };

  return { autosave, state, discard };
};
