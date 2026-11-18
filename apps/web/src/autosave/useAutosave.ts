import type { CreateDraftDocumentInput, Document, DocumentDraft, DocumentSummary } from '@reviewr/shared';
import { ApiError, conflictOf } from '@reviewr/shared';
import type { QueryClient, QueryState } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, isNotFound, queryKeys, reachability } from '../api';
import { hasUnsavedChanges } from '../unsavedChanges';
import {
  createAutosave,
  type Autosave,
  type AutosaveState,
  type Draft,
  type SaveDraft,
  type SaveResult,
} from './autosave';
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
import { createVersionQueue, holdOnStop, type VersionQueue } from './versionQueue';

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

/**
 * A version was created: it goes in the cache, unless the cache holds a newer head; a newer draft and the title stay
 * (only renames and reads write the title, as for "Save version" in the editor).
 */
const cacheRevision = (queryClient: QueryClient, saved: Document) => {
  if (!isGone(queryClient, saved.id)) {
    queryClient.setQueryData<Document>(queryKeys.document(saved.id), (cached) => {
      if (cached === undefined) return saved;
      if (cached.revision > saved.revision) return cached;
      const newerDraft = (cached.draft?.draftVersion ?? 0) > (saved.draft?.draftVersion ?? 0);
      return { ...saved, title: cached.title, draft: newerDraft ? cached.draft : saved.draft };
    });
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) });
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
  /** The versions saved while the draft could not be saved, sent by the machine before its text (in memory only). */
  versions: VersionQueue;
  /** Editors showing this machine. */
  users: number;
  /** Whether the writer edited the text in this tab. */
  edited: boolean;
  /**
   * Whether the document query's last accepted answer, success or 404, was a 404. Written by the registry's
   * subscription to the query cache, and kept when the query is dropped from the cache; for a page not created yet,
   * whose document is never read, by the refusal that says it was deleted (rule 2 of the identity of a page).
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
   * page (after a reload, for instance) still has it; the recovery of a page deleted elsewhere gives it to the new
   * documents it saves.
   */
  title?: string;
  /** Whether the document does not exist on the server yet: its next save is its creation. */
  uncreated: () => boolean;
  /** Writes the machine's state to the local buffer again (the pending title changed). */
  mirror: () => void;
  /** Whether it is a page not created yet that holds text (see `usePagesNotCreated`). */
  listed: boolean;
}

/** A text another tab left for a document that exists, or held on a page as a copy. */
interface KeptText extends Omit<LeftText, 'base' | 'page' | 'documentId'> {
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
 * **The identity of a page.** A page written before its document exists has one id for its whole life, chosen by the
 * client, and is at most one document on the server, whatever happens to the tab, the buffer or the requests. The
 * registry follows four rules, each in one place:
 *
 * 1. **No other id, ever.** Nothing in the app sends a page's text under another id. The one exception is the
 *    writer's own act: "Save as a new document" on the recovery of a document deleted elsewhere (rule 2) makes a new
 *    document in its own right, not a continuation of the page.
 * 2. **A refused id is read before it is given up** (`createDocument`). With a client-chosen id, a creation is refused
 *    for good in two cases only. The id holds a document with another first text (422): a creation of another text of
 *    this page got there first (a write of the buffer failed after the creation's text was decided, or two tabs
 *    adopted the page without Web Locks), so the document is read and, if it exists, the page is that document: its
 *    text goes to it through the machine, as the local text on the server's draft (a conflict if the server holds
 *    another text). Or the page's document was deleted elsewhere (410, or a 422 whose read finds nothing): the page is
 *    then a document deleted elsewhere (`deleted`), shown through the same recovery as any other, its texts kept in the
 *    buffer until the writer saves them as a new document or discards them.
 * 3. **A refusal of the text, not of the id, keeps the id** (400, 413…: the server stored nothing under it). As for a
 *    draft, the text stays and a changed text is sent, as a new creation under the same id: its body is decided again
 *    from that text and written ahead like the first. Should the server hold something under the id after all, the
 *    422 of rule 2 resolves it.
 * 4. **Every page not created yet can be reached** (`usePagesNotCreated`): the blank page lists the other ones, to
 *    open, copy or discard, so that a page refused in the background or restored behind another is never out of reach.
 *
 * With a buffer that fails, nothing is durable: a creation is still sent (the server is then the only other place for
 * the text), and rule 2 keeps a stale record from making a second document.
 */

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
    let document: Document;
    try {
      document = await api.createDocument(creation);
      reachability.reportSuccess();
    } catch (error) {
      reachability.reportError(error);
      const status = error instanceof ApiError ? error.status : undefined;
      // Rule 2 of the identity of a page: the document was deleted elsewhere.
      if (status !== undefined && goneStatuses.has(status)) return deletedElsewhere(error);
      const refusal = toSaveResult(error);
      if (refusal.kind === 'rejected' && status !== 422) {
        // Rule 3: the server stored nothing under the id; a changed text is a new creation under it.
        creation = undefined;
        mirror();
        return { ...refusal, permanent: false };
      }
      if (status !== 422) return { kind: 'failed', error };
      // Rule 2: the id holds another first text; the page most likely is that document.
      try {
        document = await api.getDocument(id);
        reachability.reportSuccess();
      } catch (readError) {
        if (isNotFound(readError)) return deletedElsewhere(error);
        reachability.reportError(readError);
        return { kind: 'failed', error: readError };
      }
    }
    creating = false;
    createdIn(queryClient).add(id);
    // Not announced: the blank page must take its address before the app looks for another page (readers skip it).
    entry.listed = false;
    cacheDocument(queryClient, document);
    void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
    // The document as it is now: it holds the creation's text, unless its draft moved since or another text created
    // it (then the machine reconciles it with its own texts, and never overwrites another one).
    const confirmed = draftOf(document);
    return confirmed.content === creation.content
      ? { kind: 'saved', draftVersion: confirmed.draftVersion, content: confirmed.content }
      : { kind: 'conflict', server: confirmed };
  };
  /** Rule 2: the page's document was deleted elsewhere; nothing is sent any more, the recovery shows its texts. */
  const deletedElsewhere = (error: unknown): SaveResult => {
    entry.deleted = true;
    deletedPagesOf(queryClient).add(id);
    notifyPages(queryClient);
    return { kind: 'rejected', error, permanent: true };
  };
  const saveDraft: SaveDraft = async (draft) => {
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
  };
  const versions = createVersionQueue({
    createRevision: async (input) => {
      try {
        const saved = await api.createRevision(id, input);
        reachability.reportSuccess();
        return saved;
      } catch (error) {
        reachability.reportError(error);
        throw error;
      }
    },
    nameRevision: async (revision, name) => {
      try {
        await api.nameRevision(id, revision, name);
        reachability.reportSuccess();
      } catch (error) {
        reachability.reportError(error);
        throw error;
      }
    },
    head: () => queryClient.getQueryData<Document>(queryKeys.document(id))?.revision ?? 0,
    toSaveResult,
    onRevision: (saved) => cacheRevision(queryClient, saved),
  });
  const machine = createAutosave({
    base: draft,
    // The versions queued while the server was unreachable go first, in order, then the text.
    save: (draft) => versions.send(draft, saveDraft, () => creating),
    mustSave: versions.hasPending,
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
    versions,
    users: 0,
    edited: false,
    deleted: false,
    held: [],
    heldListeners: new Set(),
    uncreated: () => creating,
    mirror: () => mirror(),
    listed: false,
  };
  // The local buffer mirrors the machine; before the document exists, with what its creation needs. A text kept by a
  // put answered ok, or confirmed by the server (`saved`, once the document exists), no longer needs another tab's copy
  // of it.
  const mirror = () => {
    const state = machine.getSnapshot();
    const onKept = (kept: string) => letGo(queryClient, entry, kept);
    const listed = creating && state.content.trim() !== '';
    if (listed !== entry.listed) {
      entry.listed = listed;
      notifyPages(queryClient);
    }
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
  holdOnStop(machine, versions);
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
 * same id with another body (422) or a deleted one (410); so it cannot create a second document nor overwrite one. The
 * text typed since goes as a draft only once the creation was answered, on the draft it answered. A creation that may
 * have been sent is in the record (written ahead, see `entryFor`), so a record without one most likely was never sent
 * and its text can be the body; when it was (a write of the buffer failed), the 422 that answers is read as rule 2 of
 * the identity of a page says, and the page joins its document. A page whose document was deleted elsewhere comes back
 * as one: its creation is refused again, and the recovery shows its texts. A blank page holds nothing to restore: the
 * writer erased it.
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

const pageListeners = new Set<() => void>();
const pageLists = new WeakMap<QueryClient, readonly string[]>();

/** The pages not created yet that hold text changed: one appeared, was created, emptied or dropped. */
const notifyPages = (queryClient: QueryClient) => {
  pageLists.delete(queryClient);
  for (const listener of [...pageListeners]) listener();
};

/**
 * The pages not created yet that hold text, in the order their machines were made (rule 4 of their identity). A page
 * created since the last change may still be in it: readers check `isPageNotCreated`.
 */
const pagesNotCreated = (queryClient: QueryClient): readonly string[] => {
  let pages = pageLists.get(queryClient);
  if (pages === undefined) {
    pages = [...registryOf(queryClient)].flatMap(([id, entry]) => (entry.listed ? [id] : []));
    pageLists.set(queryClient, pages);
  }
  return pages;
};

/** The pages this tab found deleted elsewhere (rule 2 of their identity): once discarded, the blank page moves on. */
const deletedPages = new WeakMap<QueryClient, Set<string>>();

const deletedPagesOf = (queryClient: QueryClient): Set<string> => {
  let ids = deletedPages.get(queryClient);
  if (ids === undefined) {
    ids = new Set();
    deletedPages.set(queryClient, ids);
  }
  return ids;
};

/**
 * Whether the page `id`, not created yet, was found deleted elsewhere: it shows the recovery of its texts, and never
 * the editor again, even once they are discarded.
 */
export const usePageDeleted = (id: string): boolean => {
  const queryClient = useQueryClient();
  return useSyncExternalStore(subscribePages, () => deletedPagesOf(queryClient).has(id));
};

const isPageNotCreated = (queryClient: QueryClient, id: string): boolean =>
  registryOf(queryClient).get(id)?.uncreated() === true;

const subscribePages = (listener: () => void) => {
  pageListeners.add(listener);
  return () => {
    pageListeners.delete(listener);
  };
};

/** A page not created yet, as the blank page lists it. */
export interface PageNotCreated {
  id: string;
  content: string;
  title: string | undefined;
}

/**
 * The pages not created yet that hold text, besides the page `shownId`: restored from the buffer, refused, or left by
 * the writer for another one. The blank page lists them, so that each can be opened, copied or discarded.
 */
export const usePagesNotCreated = (shownId: string): readonly PageNotCreated[] => {
  const queryClient = useQueryClient();
  const ids = useSyncExternalStore(subscribePages, () => pagesNotCreated(queryClient));
  return ids.flatMap((id) => {
    const entry = registryOf(queryClient).get(id);
    return id === shownId || entry === undefined || !entry.uncreated()
      ? []
      : [{ id, content: entry.autosave.getSnapshot().content, title: entry.title }];
  });
};

/** Whether the writer has put nothing on the page `id` that is not created yet: another page can take its place. */
const untouched = (queryClient: QueryClient, id: string): boolean => {
  if (isCreated(queryClient, id)) return false;
  const entry = registryOf(queryClient).get(id);
  return entry === undefined || (entry.autosave.getSnapshot().content === '' && (entry.title ?? '') === '');
};

/**
 * The blank page "+ New document" shows, and its setter. A page not created yet that holds text (restored from the
 * local buffer, most often) takes the place of a blank page the writer has not touched: it is in no list until it is
 * created, and the blank page is where it was written (it had no address) and where a page whose creation failed
 * already waits. The others are listed on the blank page (see `usePagesNotCreated`). Once the blank page's document is
 * created, or its texts discarded after it was deleted elsewhere, the next page not created yet, or a new one, takes
 * its place.
 */
export const useBlankPage = (selectedId: string | undefined): [string, (id: string) => void] => {
  const queryClient = useQueryClient();
  const [blankId, setBlankId] = useState(newDocumentId);
  const pages = useSyncExternalStore(subscribePages, () => pagesNotCreated(queryClient));
  const waiting = pages.find((id) => isPageNotCreated(queryClient, id));
  // A page deleted elsewhere whose texts the writer discarded is done with, as a created one is.
  const done =
    isCreated(queryClient, blankId) ||
    (deletedPagesOf(queryClient).has(blankId) && registryOf(queryClient).get(blankId) === undefined);
  if (waiting !== undefined && waiting !== blankId && untouched(queryClient, blankId)) setBlankId(waiting);
  else if (selectedId === undefined && done) setBlankId(waiting ?? newDocumentId());
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
  notifyPages(queryClient);
};

/**
 * The machine of a document, if this tab has one: an editor shows it, it still holds text the server does not have,
 * or it holds text the writer edited in a document deleted since.
 */
export const entryOf = (queryClient: QueryClient, id: string): Readonly<Entry> | undefined =>
  registryOf(queryClient).get(id);

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
  if (entry?.listed === true) notifyPages(queryClient);
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
 * No editor shows the machine: it saves now (queued versions first), and is dropped once its text is saved. It stays
 * after a conflict or a rejection, for a text of a deleted document, and while it has copies or versions that were not
 * created, so reopening the document shows them again.
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
      copiesOf(entry).length > 0 ||
      entry.versions.getSnapshot().held.length > 0
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
  /** The versions saved while the draft could not be saved (see `versionQueue`). */
  versions: VersionQueue;
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

  return { autosave, state, discard, pendingTitle: entry.title, keepTitle, versions: entry.versions };
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
          (entry) =>
            entry.autosave.getSnapshot().status !== 'saved' ||
            orphaned(entry) ||
            entry.held.length > 0 ||
            entry.versions.getSnapshot().held.length > 0,
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
