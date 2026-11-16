import { createAutosave, type Autosave, type Draft, type SaveResult } from '@reviewr/autosave';
import { createReconcileSession, type ReconcileSession, type SessionApi } from '@reviewr/reconcile';
import type { Document, DocumentDraft } from '@reviewr/shared';
import { ApiError, conflictOf } from '@reviewr/shared';
import { createTitleSaver, type TitleSaver } from './title';

/** The draft an editor opens on: the document's draft, or its saved content when it has none. */
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
 * sending the same text again cannot help (for good if the document was deleted), `failed` otherwise (network, 5xx).
 */
export const toSaveResult = (error: unknown): SaveResult => {
  const conflict = conflictOf(error);
  if (conflict?.code === 'draft_conflict') {
    return { kind: 'conflict', server: { content: conflict.draft.content, draftVersion: conflict.draft.draftVersion } };
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

/** The text was changed before it was confirmed: the version would hold another text than the one asked for. */
export const textMoved = new Error('The text changed while the version was being saved');

export interface DraftsApi extends SessionApi {
  renameDocument(id: string, title: string | null): Promise<Document>;
}

export interface DraftsOptions {
  api: DraftsApi;
  /** Every request that settled, for the "Server unreachable" notification. */
  report: { reportSuccess(): void; reportError(error: unknown): void };
  /** A draft the autosave saved. */
  onDraft: (id: string, draft: DocumentDraft) => void;
  /** A document the server answered with: its text and revision (a version, a reconciliation), or its title. */
  onDocument: (document: Document, part: 'text' | 'title') => void;
  debounceMs?: number;
}

/** What the app keeps for an open document, outside its screen: the autosave, its reconciliation, the title. */
export interface Entry {
  autosave: Autosave;
  session: ReconcileSession;
  title: TitleSaver;
  /** How many screens show it. */
  users: number;
  /** A screen opened it and does not hold it yet: it is not dropped meanwhile. */
  opening: boolean;
}

export interface Drafts {
  /** The entry of a document, created on first use on its draft; a document read since goes to it (`read`). */
  open(document: Document): Entry;
  get(id: string): Entry | undefined;
  /** A document read from the server: a newer draft and title go to the entry, never over unsaved text. */
  read(document: Document): void;
  /** A screen shows the entry; the function returned says it left, which saves now (see `release`). */
  hold(id: string): () => void;
  /** Saves every document now (the app goes to the background). */
  flushAll(): void;
  /** Saves the draft, then makes it a version. Undefined when the draft could not be saved: the status says why. */
  saveVersion(id: string, revision: number): Promise<Document | undefined>;
  /** In a draft conflict: keeps the other device's text as a version, then saves the local text. */
  keepMine(id: string): Promise<void>;
  /** Whether "restore" may replace the text on screen now: not while a conflict or a deletion holds it. */
  canRestore(id: string): boolean;
  /** Puts an old version's title and text in the editor as an edit. False when `canRestore` is false. */
  restore(id: string, version: { title: string | null; content: string }): boolean;
  /** Drops a deleted document's entry without saving. */
  discard(id: string): void;
}

const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

export const createDrafts = (options: DraftsOptions): Drafts => {
  const { report, onDraft, onDocument, debounceMs } = options;
  const entries = new Map<string, Entry>();

  const reported = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      const answer = await request();
      report.reportSuccess();
      return answer;
    } catch (error) {
      report.reportError(error);
      throw error;
    }
  };
  const api: DraftsApi = {
    getDocument: (id) => reported(() => options.api.getDocument(id)),
    saveDraft: (id, input) => reported(() => options.api.saveDraft(id, input)),
    createRevision: (id, input) => reported(() => options.api.createRevision(id, input)),
    renameDocument: (id, title) => reported(() => options.api.renameDocument(id, title)),
  };

  const create = (document: Document): Entry => {
    const { id } = document;
    const autosave = createAutosave({
      base: draftOf(document),
      debounceMs,
      save: async (draft) => {
        try {
          const saved = await api.saveDraft(id, draft);
          onDraft(id, saved);
          return { kind: 'saved', draftVersion: saved.draftVersion };
        } catch (error) {
          return toSaveResult(error);
        }
      },
    });
    const session = createReconcileSession({
      id,
      autosave,
      api,
      isConflict,
      onDocument: (saved) => onDocument(saved, 'text'),
    });
    const title = createTitleSaver({
      initial: document.title,
      debounceMs,
      rename: async (value) => onDocument(await api.renameDocument(id, value), 'title'),
    });
    return { autosave, session, title, users: 0, opening: false };
  };

  const entryOf = (id: string): Entry => {
    const entry = entries.get(id);
    if (entry === undefined) throw new Error(`No draft is open for document ${id}`);
    return entry;
  };

  const drop = (id: string, entry: Entry) => {
    if (entries.get(id) === entry) entries.delete(id);
    entry.autosave.dispose();
    entry.title.dispose();
  };

  /**
   * No screen shows the entry: it saves now, and is dropped once the text and the title are saved. It keeps retrying
   * meanwhile. After a conflict or a refusal it stays, so opening the document again shows the text and the notice.
   */
  const release = (id: string, entry: Entry) => {
    if (entry.users > 0) return;
    void entry.autosave.flush();
    entry.title.blur();
    const check = () => {
      const { status } = entry.autosave.getSnapshot();
      if (entry.users > 0 || entry.opening || status === 'conflict' || status === 'rejected') {
        stop();
      } else if (status === 'saved' && entry.title.getSnapshot().status === 'saved') {
        stop();
        drop(id, entry);
      }
    };
    const unsubscribers = [entry.autosave.subscribe(check), entry.title.subscribe(check)];
    const stop = () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    check();
  };

  const canRestore = (id: string): boolean => {
    const entry = entries.get(id);
    if (entry === undefined || entry.session.getSnapshot().running) return false;
    const state = entry.autosave.getSnapshot();
    return state.status !== 'conflict' && !(state.status === 'rejected' && state.permanent);
  };

  const read = (document: Document) => {
    const entry = entries.get(document.id);
    if (entry === undefined) return;
    if (document.draft !== undefined) entry.autosave.refresh(draftOf(document));
    entry.title.refresh(document.title);
  };

  return {
    open(document) {
      let entry = entries.get(document.id);
      if (entry === undefined) {
        entry = create(document);
        entries.set(document.id, entry);
      } else {
        read(document);
      }
      entry.opening = true;
      return entry;
    },

    get: (id) => entries.get(id),

    read,

    hold(id) {
      const entry = entryOf(id);
      entry.users++;
      entry.opening = false;
      return () => {
        entry.users--;
        // Deferred, so a screen shown again at once (a remount) keeps the same entry.
        queueMicrotask(() => release(id, entry));
      };
    },

    flushAll() {
      for (const entry of entries.values()) {
        void entry.autosave.flush();
        entry.title.blur();
      }
    },

    async saveVersion(id, revision) {
      const { autosave } = entryOf(id);
      const text = autosave.getSnapshot().content;
      if ((await autosave.flush()) !== 'saved') return undefined;
      // The flush may end on a later text, typed after the tap and sent along with it: that one is not the version.
      const { draftVersion, content } = autosave.getSnapshot().base;
      if (content !== text) throw textMoved;
      let baseRevision = revision;
      // The head moved elsewhere, not the draft: that version stays in the history, and the draft is saved over it.
      for (let attempt = 1; ; attempt++) {
        try {
          const saved = await api.createRevision(id, {
            draftVersion,
            baseRevision: baseRevision === 0 ? null : baseRevision,
          });
          autosave.refresh(draftOf(saved));
          onDocument(saved, 'text');
          return saved;
        } catch (error) {
          const conflict = conflictOf(error);
          // The draft moved elsewhere: the local text stays, and is a conflict unless the draft holds it.
          if (conflict?.code === 'draft_conflict') autosave.refresh(conflict.draft, true);
          if (conflict?.code !== 'stale_revision' || attempt === 3) throw error;
          baseRevision = conflict.revision;
        }
      }
    },

    async keepMine(id) {
      const { autosave, session } = entryOf(id);
      const state = autosave.getSnapshot();
      if (state.status === 'conflict') await session.confirm(state.content);
    },

    canRestore,

    restore(id, version) {
      if (!canRestore(id)) return false;
      const { autosave, title } = entryOf(id);
      title.edit(version.title ?? '');
      autosave.edit(version.content);
      return true;
    },

    discard(id) {
      const entry = entries.get(id);
      if (entry !== undefined) drop(id, entry);
    },
  };
};
