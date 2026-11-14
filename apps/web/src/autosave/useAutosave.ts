import type { CreateDraftDocumentInput, Document, DocumentDraft, DocumentSummary } from '@reviewr/shared';
import { ApiError, conflictOf } from '@reviewr/shared';
import type { QueryClient, QueryState } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, isNotFound, queryKeys, reachability } from '../api';
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

/**
 * What a failed creation means for the autosave. The creation is sent again as it was first sent, so a refusal (4xx)
 * is for good: the text stays, and the writer can try again under a new id. Anything else is retried.
 */
const toCreateResult = (error: unknown): SaveResult => {
  const result = toSaveResult(error);
  return result.kind === 'rejected' ? { ...result, permanent: true } : { kind: 'failed', error };
};

/** A new document's id, chosen here so that its creation can be sent again safely. */
export const newDocumentId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Pages served over plain HTTP have no `randomUUID`: a version 4 UUID from random bytes.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * A document that does not exist on the server yet: the blank page. Its draft is empty at version 0; its first save
 * creates it (see `entryFor`).
 */
export const blankDocument = (id: string): Document => {
  const now = new Date().toISOString();
  return {
    id,
    title: null,
    revision: 0,
    content: '',
    createdAt: now,
    updatedAt: now,
    draft: { content: '', draftVersion: 0, baseRevision: null },
  };
};

/** The ids of the documents this tab created, kept so that a blank page is never shown again on one of them. */
const createdIds = new WeakMap<QueryClient, Set<string>>();

const createdIn = (queryClient: QueryClient): Set<string> => {
  let ids = createdIds.get(queryClient);
  if (ids === undefined) {
    ids = new Set();
    createdIds.set(queryClient, ids);
  }
  return ids;
};

/** Whether this tab created the document `id` (its creation was answered). */
export const isCreated = (queryClient: QueryClient, id: string): boolean => createdIn(queryClient).has(id);

/** Whether the document query holds a 404: the document no longer exists. */
const goneState = (state: QueryState | undefined): boolean => state?.status === 'error' && isNotFound(state.error);

/**
 * Whether the document is known to be gone: its query holds a 404 (mirrored in its machine's entry, which keeps it
 * through a failed refetch and once the query is dropped from the cache). Only a read of the document can say that it
 * exists again: the answer of a write cannot tell whether the server took the write before the deletion.
 */
export const isGone = (queryClient: QueryClient, id: string): boolean =>
  registryOf(queryClient).get(id)?.deleted ?? goneState(queryClient.getQueryState(queryKeys.document(id)));

/** Puts a document a write answered with in the cache, unless the document is known to be gone. */
export const cacheDocument = (queryClient: QueryClient, document: Document) => {
  if (!isGone(queryClient, document.id)) queryClient.setQueryData(queryKeys.document(document.id), document);
};

/** A draft was just saved: it goes in the cache, and the document moves up the list, without a request. */
const cacheSavedDraft = (queryClient: QueryClient, id: string, draft: DocumentDraft) => {
  if (isGone(queryClient, id)) return;
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
  /** Whether the writer edited the text in this tab. */
  edited: boolean;
  /**
   * Whether the document query's last accepted answer, success or 404, was a 404. Written only by the registry's
   * subscription to the query cache; kept when the query is dropped from the cache.
   */
  deleted: boolean;
}

/**
 * Whether the machine holds text the writer may still need though it is saved: they edited it, and the document was
 * deleted since, so the server's copy is gone. Kept until the writer discards it.
 */
const orphaned = (entry: Entry): boolean =>
  entry.edited && entry.deleted && entry.autosave.getSnapshot().content.trim() !== '';

/**
 * The machines of the open documents, one per document. A machine outlives its editor until its text is saved, so
 * leaving a document never drops what was typed. One registry per query client, so each test starts empty.
 */
const registries = new WeakMap<QueryClient, Map<string, Entry>>();

const registryOf = (queryClient: QueryClient): Map<string, Entry> => {
  let registry = registries.get(queryClient);
  if (registry === undefined) {
    const entries = new Map<string, Entry>();
    registry = entries;
    registries.set(queryClient, entries);
    // The one writer of `deleted`: the state each document query settled on. Cancelled and superseded answers never
    // reach it, and no write into the cache can turn a 404 into a success (see `isGone`).
    queryClient.getQueryCache().subscribe(({ type, query }) => {
      const [scope, id, sub] = query.queryKey as readonly unknown[];
      if (type !== 'updated' || scope !== 'documents' || typeof id !== 'string' || sub !== undefined) return;
      const entry = entries.get(id);
      // Another failure (the server unreachable) says nothing either way: the last evidence stands.
      if (entry !== undefined && (query.state.status === 'success' || goneState(query.state))) {
        entry.deleted = query.state.status !== 'success';
      }
    });
  }
  return registry;
};

/**
 * The machine of a document, created on first use. For a document that does not exist on the server yet (`create`),
 * the first save creates it: a blank text creates nothing, and the first text sent is the creation's body for good,
 * sent again as it is until it is answered (the server refuses the same id with another body). The answer tells the
 * machine which text the server holds, and the machine sends the text typed since as a draft.
 */
const entryFor = (queryClient: QueryClient, document: Document, create = false): Entry => {
  const registry = registryOf(queryClient);
  const existing = registry.get(document.id);
  if (existing !== undefined) return existing;

  const { id } = document;
  let creating = create && !isCreated(queryClient, id);
  let creation: CreateDraftDocumentInput | undefined;
  const createDocument = async (draft: Draft): Promise<SaveResult> => {
    if (creation === undefined) {
      // Nothing to keep yet: no request, and the blank text counts as saved.
      if (draft.content.trim() === '') return { kind: 'saved', draftVersion: 0 };
      creation = { id, content: draft.content, draftOnly: true };
    }
    let created: Document;
    try {
      created = await api.createDocument(creation);
      reachability.reportSuccess();
    } catch (error) {
      reachability.reportError(error);
      return toCreateResult(error);
    }
    creating = false;
    createdIn(queryClient).add(id);
    cacheDocument(queryClient, created);
    void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
    // The document as it is now: it holds the creation's text, unless its draft moved since (then the machine
    // reconciles it with its own texts, and never overwrites another one).
    const confirmed = draftOf(created);
    return confirmed.content === creation.content
      ? { kind: 'saved', draftVersion: confirmed.draftVersion, content: confirmed.content }
      : { kind: 'conflict', server: confirmed };
  };
  const machine = createAutosave({
    base: draftOf(document),
    save: async (draft) => {
      if (creating) return createDocument(draft);
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
  const entry: Entry = {
    // Every edit goes through here: the entry remembers that the writer typed in this document.
    autosave: {
      ...machine,
      edit: (content) => {
        entry.edited = true;
        machine.edit(content);
      },
    },
    users: 0,
    edited: false,
    deleted: false,
  };
  registry.set(id, entry);
  return entry;
};

/**
 * The machine of a document, if this tab has one: an editor shows it, it still holds text the server does not have,
 * or it holds text the writer edited in a document deleted since.
 */
export const entryOf = (queryClient: QueryClient, id: string): Readonly<Entry> | undefined =>
  registryOf(queryClient).get(id);

/**
 * Gives the text of a page whose creation was refused a new id, to create it again; the refused machine is dropped.
 * Answers the new id.
 */
export const createAgain = (queryClient: QueryClient, id: string): string => {
  const text = registryOf(queryClient).get(id)?.autosave.getSnapshot().content ?? '';
  const next = newDocumentId();
  const entry = entryFor(queryClient, blankDocument(next), true);
  entry.autosave.edit(text);
  void entry.autosave.flush();
  discardAutosave(queryClient, id);
  return next;
};

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
      if (entry.users > 0 || status === 'conflict' || status === 'rejected' || orphaned(entry)) {
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
 * The autosave of an open document (with `create`, one that does not exist on the server yet, created by the first
 * save): the editor shows `state.content` and sends every edit to `autosave`. A newer draft in `document` (a refetch,
 * a version save) reaches the machine through `refresh`, which keeps local edits.
 */
export const useAutosave = (document: Document, create = false): UseAutosave => {
  const queryClient = useQueryClient();
  const [entry] = useState(() => entryFor(queryClient, document, create));
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
    const entries = () => [...registryOf(queryClient).values()];
    const machines = () => entries().map((entry) => entry.autosave);
    const flushAll = () => {
      for (const autosave of machines()) void autosave.flush();
    };
    const onVisibilityChange = () => {
      if (window.document.visibilityState === 'hidden') flushAll();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flushAll();
      if (
        hasUnsavedChanges() ||
        entries().some((entry) => entry.autosave.getSnapshot().status !== 'saved' || orphaned(entry))
      ) {
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
