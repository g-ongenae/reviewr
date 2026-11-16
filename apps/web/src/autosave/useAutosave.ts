import type { CreateDraftDocumentInput, Document, DocumentDraft, DocumentSummary } from '@reviewr/shared';
import { ApiError, conflictOf } from '@reviewr/shared';
import type { QueryClient, QueryState } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, isNotFound, queryKeys, reachability } from '../api';
import { hasUnsavedChanges } from '../unsavedChanges';
import { createAutosave, type Autosave, type AutosaveState, type Draft, type SaveResult } from './autosave';
import {
  adoptLeftTexts,
  dropLeftText,
  forgetDocument,
  hasDeviceBuffer,
  holds,
  keepRestored,
  keptText,
  markHanded,
  mirrored,
  mirrorState,
  type LeftText,
} from './deviceBuffer';
import type { BufferPage } from './localBuffer';

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
  /**
   * The texts gone tabs left in the local buffer for this document that this tab took over (see `restore`), each still
   * in the buffer under its old key until `letGo` deletes it. `origin` marks the text the machine was rebuilt from; the
   * others are copies for the writer, shown until they discard them or that very text is kept or saved.
   */
  held: readonly HeldText[];
  heldListeners: Set<() => void>;
  /**
   * A title typed on a page whose document does not exist yet: it can be saved only once the document is created, by
   * the editor shown then. Kept here (and with the page in the local buffer) so that an editor mounted again on the
   * page (after "Try again", or a reload) still has it.
   */
  title?: string;
  /** Whether the document does not exist on the server yet: its next save is its creation. */
  uncreated: () => boolean;
  /** Writes the machine's state to the local buffer again (the pending title changed). */
  mirror: () => void;
}

/** A text another tab left for a document that exists, or held on a page as a copy. */
interface KeptText extends Omit<LeftText, 'base' | 'page'> {
  base: Draft;
}

/** A text another tab left, taken over by this tab's registry. */
interface HeldText extends KeptText {
  origin: boolean;
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
 * machine which text the server holds, and the machine sends the text typed since as a draft. `sent` is the text of a
 * creation that may have been sent already (a page restored from the local buffer): the body is then that one.
 *
 * Such a page is kept in the local buffer with its creation's text, written before the creation is first sent: a
 * restore after a crash sends the very same creation again (see `restorePage`).
 */
const entryFor = (queryClient: QueryClient, id: string, draft: Draft, create = false, sent?: string): Entry => {
  const registry = registryOf(queryClient);
  const existing = registry.get(id);
  if (existing !== undefined) return existing;

  let creating = create && !isCreated(queryClient, id);
  let creation: CreateDraftDocumentInput | undefined =
    creating && sent !== undefined ? { id, content: sent, draftOnly: true } : undefined;
  const createDocument = async (draft: Draft): Promise<SaveResult> => {
    if (creation === undefined) {
      // Nothing to keep yet: no request, and the blank text counts as saved.
      if (draft.content.trim() === '') return { kind: 'saved', draftVersion: 0 };
      creation = { id, content: draft.content, draftOnly: true };
      // Written ahead: the creation is sent once the buffer answered a write holding its text (unless its entry holds
      // that very text already), so a crash can never leave a record from which a restore would send another body. A
      // buffer that fails does not hold the creation back (it has said so to the writer), and the server is then the
      // only other place for the text.
      if (!holds(queryClient, id, creation.content)) {
        mirror();
        await mirrored(queryClient, id);
      }
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
    base: draft,
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
    held: [],
    heldListeners: new Set(),
    uncreated: () => creating,
    mirror: () => mirror(),
  };
  // The local buffer mirrors the machine; before the document exists, with what its creation needs. A text kept by a
  // put answered ok, or confirmed by the server (`saved`, once the document exists), no longer needs another tab's copy
  // of it.
  const mirror = () => {
    const state = machine.getSnapshot();
    const onKept = (kept: string) => letGo(queryClient, entry, kept);
    if (creating) {
      const page: BufferPage = { creation: creation?.content ?? null };
      if (entry.title !== undefined) page.title = entry.title;
      mirrorState(queryClient, id, state, onKept, page);
      return;
    }
    mirrorState(queryClient, id, state, onKept);
    if (state.status === 'saved') letGo(queryClient, entry, state.content);
  };
  machine.subscribe(mirror);
  registry.set(id, entry);
  return entry;
};

const setHeld = (entry: Entry, held: readonly HeldText[]) => {
  entry.held = held;
  for (const listener of [...entry.heldListeners]) listener();
};

/**
 * `content` is kept elsewhere: the server confirmed it, or a put of it under this tab's key was answered ok. Every
 * other tab's entry holding that very text goes. With the writer's discard (`discardCopy`, `discardAutosave`), the only
 * way such an entry leaves the buffer: the invariant of adoption, in `deviceBuffer`.
 */
const letGo = (queryClient: QueryClient, entry: Entry, content: string) => {
  const kept = entry.held.filter((text) => text.content === content);
  if (kept.length === 0) return;
  for (const text of kept) dropLeftText(queryClient, text.key, text.content);
  setHeld(
    entry,
    entry.held.filter((text) => !kept.includes(text)),
  );
};

/** Takes texts over as held, then lets go at once of those already kept by this tab or confirmed by the server. */
const hold = (queryClient: QueryClient, id: string, entry: Entry, texts: readonly HeldText[]) => {
  setHeld(entry, [...entry.held, ...texts]);
  const state = entry.autosave.getSnapshot();
  // A page not created yet is `saved` only when blank, which the server never confirmed.
  if (state.status === 'saved' && !entry.uncreated()) letGo(queryClient, entry, state.content);
  const kept = keptText(queryClient, id);
  if (kept !== undefined) letGo(queryClient, entry, kept);
};

/**
 * Whether a text can be sent on the base it was written from, judged on the server's draft read just now: the server is
 * at that base or later (a counter read from the disk is not the machine's authority), and the text is not its base's
 * (it would look saved without the server having confirmed it).
 */
const resumable = (text: KeptText, server: Draft): boolean =>
  text.content !== text.base.content &&
  (server.draftVersion > text.base.draftVersion ||
    (server.draftVersion === text.base.draftVersion && server.content === text.base.content));

/**
 * Rebuilds what gone tabs left for a document, decided on the server's draft read now. A text the server holds is
 * let go. With no machine in this tab yet, the most recent text that can be sent on its base becomes the local text and
 * is saved like any text (in the background if no editor shows it); if the server moved, the machine's own conflict
 * path runs. Every other text is held as a copy for the writer, never merged, sent or dropped: one whose base is ahead
 * of the server or is its own base, for instance. Answers `false` when the server could not be read: nothing is
 * decided, and the texts stay in the buffer to be restored later.
 *
 * Pages whose document did not exist yet are restored by `restorePage`. Mixed with texts of the document (a tab
 * adopted the page, created it, then crashed too), the document exists: each page text then counts as written on the
 * creation's text, at version 0, which the server is past, so that sending it can only meet a conflict (resolved
 * without the writer if the server still holds that text), never overwrite a draft.
 */
const restore = async (queryClient: QueryClient, id: string, left: readonly LeftText[]): Promise<boolean> => {
  if (left.every((text) => text.base === null)) return restorePage(queryClient, id, left);
  const texts = left.map(({ key, content, base, page }) => ({
    key,
    content,
    base: base ?? { content: page?.creation ?? content, draftVersion: 0 },
  }));
  const registry = registryOf(queryClient);
  let server: Draft | undefined;
  if (registry.get(id) === undefined) {
    try {
      const document = await api.getDocument(id);
      reachability.reportSuccess();
      cacheDocument(queryClient, document);
      server = draftOf(document);
    } catch (error) {
      // Not reported to `reachability`: its return triggers this restore again, which would loop while only this
      // read fails. The server's return, seen by other requests, or the open document's timer brings it back.
      if (!isNotFound(error)) return false;
    }
  }
  if (abandoned.has(queryClient)) return false;
  markHanded(
    queryClient,
    texts.map((text) => text.key),
  );
  // The server confirmed these texts: nothing to restore, the entries go.
  for (const text of texts) {
    if (server !== undefined && text.content === server.content) dropLeftText(queryClient, text.key, text.content);
  }
  const unconfirmed = texts.filter((text) => server === undefined || text.content !== server.content);
  if (unconfirmed.length === 0) return true;

  let entry = registry.get(id);
  // A document deleted meanwhile (404): the newest text goes to the machine, whose save meets the deletion and shows
  // the recovery page.
  const origin =
    entry === undefined
      ? unconfirmed.find((text) =>
          server === undefined ? text.content !== text.base.content : resumable(text, server),
        )
      : undefined;
  if (entry === undefined) {
    // Without a text to send, the machine starts on the server's draft (or nothing): never on a base read from the
    // disk, which would make a held text look confirmed.
    entry = entryFor(queryClient, id, origin?.base ?? server ?? { content: '', draftVersion: 0 });
    if (origin !== undefined) {
      entry.autosave.edit(origin.content);
      const restored = entry;
      keepRestored(queryClient, id, origin.content, origin.base, (kept) => letGo(queryClient, restored, kept));
    }
    const created = entry;
    queueMicrotask(() => saveInBackground(queryClient, id, created));
  }
  hold(
    queryClient,
    id,
    entry,
    unconfirmed.map((text) => ({ ...text, origin: origin !== undefined && text.content === origin.content })),
  );
  return true;
};

/**
 * Rebuilds pages gone tabs left before their document existed (the same page can be left by two tabs, when one adopted
 * it and crashed in turn). The most recent text becomes the page's text, the others are held as copies; the title
 * comes back with it. The machine starts as a page not created yet, whose creation is the one the records say was
 * sent, or the restored text if none was: decided now, so that a page restored by two tabs (no Web Locks) is created
 * with one body. It is sent in the background, and shown on the blank page (see `useBlankPage`).
 *
 * Nothing is read before. Where an existing document's restore reads the server's draft, the creation itself is the
 * read: the server answers the same id and body with the document as it is now, never changing it, and refuses the
 * same id with another body (422) or a deleted one (410), for good; so it cannot create a second document nor
 * overwrite one. The text typed since goes as a draft only once the creation was answered, on the draft it answered.
 * A creation that may have been sent is always in the record (written ahead, see `entryFor`); a record without one
 * was never sent, so its text can be the body. A blank page holds nothing to restore: the writer erased it.
 */
const restorePage = (queryClient: QueryClient, id: string, pages: readonly LeftText[]): boolean => {
  if (abandoned.has(queryClient)) return false;
  markHanded(
    queryClient,
    pages.map((page) => page.key),
  );
  const erased = (page: LeftText) => page.content.trim() === '';
  for (const page of pages) if (erased(page)) dropLeftText(queryClient, page.key, page.content);
  const left = pages.filter((page) => !erased(page));
  const [newest] = left;
  if (newest === undefined) return true;
  const sent = left.find((page) => (page.page?.creation ?? null) !== null)?.page?.creation ?? newest.content;
  const blank: Draft = { content: '', draftVersion: 0 };
  let entry = registryOf(queryClient).get(id);
  const origin = entry === undefined ? newest : undefined;
  if (entry === undefined) {
    entry = entryFor(queryClient, id, blank, true, sent);
    const restored = entry;
    const page: BufferPage = { creation: sent };
    if (newest.page?.title !== undefined) {
      restored.title = newest.page.title;
      page.title = newest.page.title;
    }
    restored.autosave.edit(newest.content);
    keepRestored(queryClient, id, newest.content, null, (kept) => letGo(queryClient, restored, kept), page);
    const pagesOf = restoredPagesOf(queryClient);
    if (!pagesOf.includes(id)) pagesOf.push(id);
    for (const listener of [...restoredPageListeners]) listener();
    queueMicrotask(() => saveInBackground(queryClient, id, restored));
  }
  hold(
    queryClient,
    id,
    entry,
    left.map(({ key, content }) => ({ key, content, base: blank, origin: content === origin?.content })),
  );
  return true;
};

/** The pages `restorePage` rebuilt in this tab, in order: each is the blank page in turn, until it is created. */
const restoredPages = new WeakMap<QueryClient, string[]>();
const restoredPageListeners = new Set<() => void>();

const restoredPagesOf = (queryClient: QueryClient): string[] => {
  let pages = restoredPages.get(queryClient);
  if (pages === undefined) {
    pages = [];
    restoredPages.set(queryClient, pages);
  }
  return pages;
};

/** The first restored page whose document does not exist yet, and whose machine is still there. */
const restoredPage = (queryClient: QueryClient): string | undefined =>
  restoredPagesOf(queryClient).find((id) => registryOf(queryClient).get(id)?.uncreated() === true);

const subscribeRestoredPages = (listener: () => void) => {
  restoredPageListeners.add(listener);
  return () => {
    restoredPageListeners.delete(listener);
  };
};

/** Whether the writer has put nothing on the page `id` that is not created yet: another page can take its place. */
const untouched = (queryClient: QueryClient, id: string): boolean => {
  if (isCreated(queryClient, id)) return false;
  const entry = registryOf(queryClient).get(id);
  return entry === undefined || (entry.autosave.getSnapshot().content === '' && (entry.title ?? '') === '');
};

/**
 * The blank page "+ New document" shows, and its setter. A page restored from the local buffer whose document does
 * not exist yet takes the place of a blank page the writer has not touched: it is in no list until it is created, and
 * the blank page is where it was written (it had no address) and where a page whose creation failed already waits.
 * Once the blank page's document is created, the next restored page, or a new one, takes its place.
 */
export const useBlankPage = (selectedId: string | undefined): [string, (id: string) => void] => {
  const queryClient = useQueryClient();
  const [blankId, setBlankId] = useState(newDocumentId);
  const restored = useSyncExternalStore(subscribeRestoredPages, () => restoredPage(queryClient));
  if (restored !== undefined && restored !== blankId && untouched(queryClient, blankId)) setBlankId(restored);
  else if (selectedId === undefined && isCreated(queryClient, blankId)) {
    setBlankId(restoredPage(queryClient) ?? newDocumentId());
  }
  return [blankId, setBlankId];
};

/** Query clients of pages that crashed, in tests: nothing is restored for them any more (see `abandonAutosave`). */
const abandoned = new WeakSet<QueryClient>();

const restoring = new WeakMap<QueryClient, Promise<unknown>>();

/**
 * The texts waiting for the server, by document: texts gone tabs left, read under their locks, on which no restore
 * could decide because the server's draft could not be read. Shown read-only and guarded on unload; nothing is sent
 * before a decision.
 *
 * A view of the buffer, owned by `restoreLeftTexts` alone: after each successful scan, every document the scan covered
 * holds exactly its texts still undecided (a document absent from the scan, whose texts another tab saved and removed,
 * drops out); a failed scan changes nothing. While anything waits, the registry tries again on its own, with a backoff,
 * whatever document is open.
 */
const waitingTexts = new WeakMap<QueryClient, Map<string, readonly string[]>>();
const waitingListeners = new Set<() => void>();
const retries = new WeakMap<QueryClient, { timer?: ReturnType<typeof setTimeout>; delay: number }>();
/**
 * How many app guards hold each registry (see `useAutosaveGuard`). The registry tries waiting restores again only
 * while the app is shown: once the app is removed from the page without the page going away (a hot reload, a test),
 * nothing may go on reading and saving behind it.
 */
const guards = new WeakMap<QueryClient, number>();

/** How long the registry waits before it tries a waiting restore again, then up to `restoreRetryMaxMs`. */
const restoreRetryMs = 5000;
const restoreRetryMaxMs = 60_000;

const waitingOf = (queryClient: QueryClient): Map<string, readonly string[]> => {
  let waiting = waitingTexts.get(queryClient);
  if (waiting === undefined) {
    waiting = new Map();
    waitingTexts.set(queryClient, waiting);
  }
  return waiting;
};

/** Tries every waiting restore again after a while, while anything waits; never twice at once. */
const scheduleRetry = (queryClient: QueryClient) => {
  const retry = retries.get(queryClient) ?? { delay: restoreRetryMs };
  retries.set(queryClient, retry);
  if (waitingOf(queryClient).size === 0 || abandoned.has(queryClient) || (guards.get(queryClient) ?? 0) === 0) {
    clearTimeout(retry.timer);
    retry.timer = undefined;
    retry.delay = restoreRetryMs;
    return;
  }
  if (retry.timer !== undefined) return;
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    retry.delay = Math.min(retry.delay * 2, restoreRetryMaxMs);
    void restoreLeftTexts(queryClient);
  }, retry.delay);
};

/**
 * Restores the texts gone tabs left for every document, or for `id` only, one restore at a time, then brings the
 * waiting texts in line with what it found (see `waitingTexts`). Answers the documents whose texts wait for the server.
 */
const restoreLeftTexts = (queryClient: QueryClient, id?: string): Promise<Set<string>> => {
  const run = async () => {
    const waiting = waitingOf(queryClient);
    if (abandoned.has(queryClient)) return new Set<string>();
    const left = await adoptLeftTexts(queryClient, id);
    if (left !== undefined) {
      const undecided = new Map<string, readonly string[]>();
      for (const [documentId, texts] of left) {
        if (!(await restore(queryClient, documentId, texts))) {
          undecided.set(documentId, [...new Set(texts.map((text) => text.content))]);
        }
      }
      // The scan covered every document, or only `id`: those hold what it left undecided, nothing else.
      for (const documentId of [...waiting.keys()]) {
        if ((id === undefined || documentId === id) && !undecided.has(documentId)) waiting.delete(documentId);
      }
      for (const [documentId, texts] of undecided) waiting.set(documentId, texts);
      for (const listener of [...waitingListeners]) listener();
    }
    scheduleRetry(queryClient);
    return new Set(id === undefined ? waiting.keys() : waiting.has(id) ? [id] : []);
  };
  const previous = restoring.get(queryClient) ?? Promise.resolve();
  const next = previous.then(run, run);
  restoring.set(queryClient, next);
  return next;
};

const subscribeWaiting = (listener: () => void) => {
  waitingListeners.add(listener);
  return () => {
    waitingListeners.delete(listener);
  };
};

/** The texts this device kept for the document `id` whose restore waits for the server (see `waitingTexts`). */
export const useWaitingTexts = (id: string): readonly string[] => {
  const queryClient = useQueryClient();
  return useSyncExternalStore(subscribeWaiting, () => waitingOf(queryClient).get(id) ?? noCopies);
};

/**
 * For tests: what a crash leaves of a page. Its machines stop without saving and nothing more is restored; the buffer
 * is left as it is.
 */
export const abandonAutosave = (queryClient: QueryClient) => {
  abandoned.add(queryClient);
  const registry = registryOf(queryClient);
  for (const entry of registry.values()) entry.autosave.dispose();
  registry.clear();
};

/**
 * The machine of a document, if this tab has one: an editor shows it, it still holds text the server does not have,
 * or it holds text the writer edited in a document deleted since.
 */
export const entryOf = (queryClient: QueryClient, id: string): Readonly<Entry> | undefined =>
  registryOf(queryClient).get(id);

/**
 * Gives the text and the title of a page whose creation was refused a new id, to create it again; the refused machine
 * is dropped, and the copies other tabs left for it move to the new page. The refused page's entry in the local buffer
 * goes only once the new page's is written (or created): a crash in between would otherwise lose the text. Answers
 * the new id.
 */
export const createAgain = (queryClient: QueryClient, id: string): string => {
  const registry = registryOf(queryClient);
  const refused = registry.get(id);
  const text = refused?.autosave.getSnapshot().content ?? '';
  const next = newDocumentId();
  const entry = entryFor(queryClient, next, draftOf(blankDocument(next)), true);
  entry.title = refused?.title;
  entry.autosave.edit(text);
  void entry.autosave.flush();
  if (refused !== undefined) {
    refused.autosave.dispose();
    registry.delete(id);
    setHeld(entry, refused.held);
  }
  void mirrored(queryClient, next).then(() => {
    if (keptText(queryClient, next) !== undefined || isCreated(queryClient, next)) forgetDocument(queryClient, id);
  });
  return next;
};

/** Keeps the title typed on a page whose document is not created yet, with its machine (see `Entry.title`). */
const keepPendingTitle = (queryClient: QueryClient, id: string, title: string) => {
  const entry = registryOf(queryClient).get(id);
  if (entry === undefined) return;
  entry.title = title;
  entry.mirror();
};

/** Drops a document's machine without saving, for a document that no longer exists; the writer discards its texts. */
export const discardAutosave = (queryClient: QueryClient, id: string) => {
  const registry = registryOf(queryClient);
  const entry = registry.get(id);
  entry?.autosave.dispose();
  registry.delete(id);
  forgetDocument(queryClient, id);
  for (const text of entry?.held ?? []) dropLeftText(queryClient, text.key, text.content);
};

/** The writer discards a copy another tab left for a document (every entry holding that text). */
export const discardCopy = (queryClient: QueryClient, id: string, content: string) => {
  const entry = registryOf(queryClient).get(id);
  if (entry === undefined) return;
  const discarded = entry.held.filter((text) => !text.origin && text.content === content);
  for (const text of discarded) dropLeftText(queryClient, text.key, text.content);
  setHeld(
    entry,
    entry.held.filter((text) => !discarded.includes(text)),
  );
};

const noCopies: readonly string[] = [];

/** The copies other tabs left for a document, to show the writer: each text once, the machine's own aside. */
const copiesOf = (entry: Entry): readonly string[] => {
  const texts = [...new Set(entry.held.filter((text) => !text.origin).map((text) => text.content))];
  return texts.length === 0 ? noCopies : texts;
};

/** The texts of the copies other tabs left for a document, besides its local text (see `restore`). */
export const useKeptCopies = (id: string): readonly string[] => {
  const queryClient = useQueryClient();
  const entry = registryOf(queryClient).get(id);
  const held = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        entry?.heldListeners.add(listener);
        return () => entry?.heldListeners.delete(listener);
      },
      [entry],
    ),
    () => entry?.held,
  );
  return entry === undefined || held === undefined ? noCopies : copiesOf(entry);
};

/** How far the restore of a document's texts went: `deferred` while the server cannot be read to decide on them. */
export type Restored = 'pending' | 'deferred' | 'done';

/**
 * Whether what the local buffer holds for the document `id` was restored: until then, nothing may show the server's
 * text as the writer's. `done` at once when `skip` (a page not created yet) or when the device keeps no buffer.
 */
export const useRestored = (id: string, skip = false): Restored => {
  const queryClient = useQueryClient();
  const settled = skip || !hasDeviceBuffer(queryClient);
  const [restored, setRestored] = useState<{ id: string; deferred: boolean } | undefined>(undefined);
  // The registry retries on its own (see `waitingTexts`): the document opens once its texts no longer wait.
  const waiting = useSyncExternalStore(subscribeWaiting, () => waitingOf(queryClient).has(id));
  useEffect(() => {
    if (settled) return;
    let live = true;
    void restoreLeftTexts(queryClient, id).then((deferred) => {
      if (live) setRestored({ id, deferred: deferred.has(id) });
    });
    return () => {
      live = false;
    };
  }, [queryClient, id, settled]);
  if (settled) return 'done';
  if (restored?.id !== id) return 'pending';
  return restored.deferred && waiting ? 'deferred' : 'done';
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
  queueMicrotask(() => saveInBackground(queryClient, id, entry));
};

/**
 * No editor shows the machine: it saves now, and is dropped once its text is saved. It stays after a conflict or a
 * rejection, for a text of a deleted document, and while it has copies, so reopening the document shows them again.
 */
const saveInBackground = (queryClient: QueryClient, id: string, entry: Entry) => {
  if (entry.users > 0) return;
  const { autosave } = entry;
  void autosave.flush();
  const check = () => {
    const { status } = autosave.getSnapshot();
    if (
      entry.users > 0 ||
      status === 'conflict' ||
      status === 'rejected' ||
      orphaned(entry) ||
      copiesOf(entry).length > 0
    ) {
      unsubscribe();
    } else if (status === 'saved') {
      const registry = registryOf(queryClient);
      if (registry.get(id) === entry) registry.delete(id);
      autosave.dispose();
    }
  };
  const unsubscribe = autosave.subscribe(check);
  check();
};

export interface UseAutosave {
  autosave: Autosave;
  state: AutosaveState;
  /** Drops the machine without saving, for a document that no longer exists. */
  discard: () => void;
  /** The title typed on the page before its document was created, if any (see `Entry.title`). */
  pendingTitle: string | undefined;
  /** Keeps the title typed on a page whose document is not created yet. */
  keepTitle: (title: string) => void;
}

/**
 * The autosave of an open document (with `create`, one that does not exist on the server yet, created by the first
 * save): the editor shows `state.content` and sends every edit to `autosave`. A newer draft in `document` (a refetch,
 * a version save) reaches the machine through `refresh`, which keeps local edits.
 */
export const useAutosave = (document: Document, create = false): UseAutosave => {
  const queryClient = useQueryClient();
  const [entry] = useState(() => entryFor(queryClient, document.id, draftOf(document), create));
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

  const keepTitle = (title: string) => keepPendingTitle(queryClient, document.id, title);

  return { autosave, state, discard, pendingTitle: entry.title, keepTitle };
};

/**
 * Guards every machine of the app, including those of documents the writer already left: hiding the tab or closing the
 * page saves them all at once, and closing it warns while any of them (or the open editor, through `unsavedChanges`)
 * holds text the server does not have. Used once, by the app.
 */
export const useAutosaveGuard = () => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // What crashed or closed tabs left is restored, and saved in the background; what waited for the server, once it
    // is back.
    guards.set(queryClient, (guards.get(queryClient) ?? 0) + 1);
    void restoreLeftTexts(queryClient);
    const unsubscribe = reachability.subscribe(() => {
      if (!reachability.isUnreachable()) void restoreLeftTexts(queryClient);
    });
    const entries = () => [...registryOf(queryClient).values()];
    const machines = () => entries().map((entry) => entry.autosave);
    const flushAll = () => {
      for (const autosave of machines()) void autosave.flush();
    };
    const onVisibilityChange = () => {
      if (window.document.visibilityState === 'hidden') flushAll();
    };
    // A text the local buffer keeps still warns: the buffer brings it back on this browser only, and only once the
    // app is opened again here, while the writer may expect it on the server (another device). It is the net for a
    // crash or an ignored warning, not a reason to stop warning.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flushAll();
      if (
        hasUnsavedChanges() ||
        // Texts other tabs left that the server does not hold yet: held copies, and restores waiting for the server.
        waitingOf(queryClient).size > 0 ||
        entries().some(
          (entry) => entry.autosave.getSnapshot().status !== 'saved' || orphaned(entry) || entry.held.length > 0,
        )
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
      unsubscribe();
      // The last guard gone, the registry stops trying on its own, and a restore still running does not start it
      // again. The waiting texts stay in the buffer; the next guard (a remount, strict mode) restores them.
      guards.set(queryClient, (guards.get(queryClient) ?? 1) - 1);
      scheduleRetry(queryClient);
    };
  }, [queryClient]);
};
