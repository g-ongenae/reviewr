import type { Document, DocumentDraft, DocumentSummary } from '@reviewr/shared';
import { ApiError, conflictOf } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, queryKeys, reachability } from '../api';
import { hasUnsavedChanges } from '../unsavedChanges';
import { createAutosave, type Autosave, type AutosaveState, type Draft, type SaveResult } from './autosave';

/**
 * The draft an editor opens on. The API always sends it; documents without one (fixtures written before drafts
 * existed) open on their last version.
 */
export const draftOf = (document: Document): Draft => {
  const { content, draftVersion } = document.draft ?? { content: document.content, draftVersion: 1 };
  return { content, draftVersion };
};

/** 4xx statuses a later attempt can still get through: everything else in 4xx refuses the text sent. */
const retryableClientErrors = new Set([408, 425, 429]);

/** Statuses that say the document itself is gone: no text will ever be accepted. */
const goneStatuses = new Set([404, 410]);

/**
 * What a failed `saveDraft` means for the autosave: the other device's draft on a draft conflict, `rejected` when
 * sending the same text again cannot help (for good if the document was deleted; a changed text may pass a size or
 * validation error), `failed` otherwise (network, 5xx).
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
    return { kind: 'rejected', error, permanent: goneStatuses.has(error.status) };
  }
  return { kind: 'failed', error };
};

/** A draft was just saved: it goes in the cache, and the document moves up the list, without a request. */
const cacheSavedDraft = (queryClient: QueryClient, id: string, draft: DocumentDraft) => {
  const updatedAt = new Date().toISOString();
  queryClient.setQueryData<Document>(queryKeys.document(id), (document) => {
    // A slow answer must not move the cached draft back under a newer one read since.
    if (document === undefined || (document.draft?.draftVersion ?? 0) > draft.draftVersion) return document;
    return { ...document, draft, updatedAt };
  });
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
        cacheSavedDraft(queryClient, id, saved);
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

/** The machine of a document, if this tab has one: an editor shows it, or it still holds text the server does not have. */
export const autosaveOf = (queryClient: QueryClient, id: string): Autosave | undefined =>
  registryOf(queryClient).get(id)?.autosave;

/** Drops a document's machine without saving, for a document that no longer exists. */
export const discardAutosave = (queryClient: QueryClient, id: string) => {
  const registry = registryOf(queryClient);
  registry.get(id)?.autosave.dispose();
  registry.delete(id);
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
 * The autosave of an open document: the editor shows `state.content` and sends every edit to `autosave`. A newer
 * draft in `document` (a refetch, a version save) reaches the machine through `refresh`, which keeps local edits.
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

  const { draft } = document;
  useEffect(() => {
    if (draft !== undefined) autosave.refresh({ content: draft.content, draftVersion: draft.draftVersion });
  }, [autosave, draft]);

  const discard = () => discardAutosave(queryClient, document.id);

  return { autosave, state, discard };
};

/**
 * Guards every machine of the app, including those of documents the writer already left: hiding the tab or closing the
 * page saves them all at once, and closing it warns while any of them (or the open editor, through `unsavedChanges`)
 * holds text the server does not have. Used once, by the app.
 */
export const useAutosaveGuard = () => {
  const queryClient = useQueryClient();

  useEffect(() => {
    const machines = () => [...registryOf(queryClient).values()].map((entry) => entry.autosave);
    const flushAll = () => {
      for (const autosave of machines()) void autosave.flush();
    };
    const onVisibilityChange = () => {
      if (window.document.visibilityState === 'hidden') flushAll();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flushAll();
      if (hasUnsavedChanges() || machines().some((autosave) => autosave.getSnapshot().status !== 'saved')) {
        event.preventDefault();
      }
    };
    window.addEventListener('pagehide', flushAll);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushAll);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queryClient]);
};
