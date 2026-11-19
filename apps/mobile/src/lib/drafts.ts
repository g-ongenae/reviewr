import { createAutosave, type Autosave, type Draft, type SaveResult } from '@reviewr/autosave';
import { createReconcileSession, type ReconcileSession, type SessionApi, type Side } from '@reviewr/reconcile';
import type { Document, DocumentDraft } from '@reviewr/shared';
import { ApiError, conflictOf } from '@reviewr/shared';
import type { LocalCopy } from './localCopy';
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
  /** The copy of each text kept on the phone until the server confirmed it (see `localCopy.ts`); none if absent. */
  copy?: LocalCopy;
  debounceMs?: number;
  now?: () => Date;
}

/** A text the phone kept in its local buffer, with the server draft it was written from. */
export interface KeptText {
  content: string;
  base: Draft;
}

/** How a restore ended: `refused` while a conflict or a deletion holds the text, `failed` when it could not be kept. */
export type RestoreOutcome = { kind: 'restored' } | { kind: 'refused' } | { kind: 'failed'; error: unknown };

/** Names the version a restore keeps by its day, as `versionName` of `@reviewr/reconcile` does. */
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** What the app keeps for an open document, outside its screen: the autosave, its reconciliation, the title. */
export interface Entry {
  autosave: Autosave;
  session: ReconcileSession;
  title: TitleSaver;
  /** The document as last opened or read: shown when the app holds a text but cannot read the document. */
  document: Document;
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
  saveVersion(id: string, revision: number, name?: string): Promise<Document | undefined>;
  /** In a draft conflict: keeps the other device's text as a version, then saves the local text. */
  keepMine(id: string): Promise<void>;
  /** Whether "restore" may replace the text on screen now: not while a conflict or a deletion holds it. */
  canRestore(id: string): boolean;
  /**
   * Puts an old version's title and text in the editor as an edit. A text on screen that is not the head revision's
   * (`head`) is first kept as a version; if it cannot be, nothing is restored. `refused` when `canRestore` is false.
   */
  restore(
    id: string,
    version: { title: string | null; content: string },
    head: { revision: number; content: string },
  ): Promise<RestoreOutcome>;
  /** Drops a deleted document's entry without saving; the phone's copy of its text goes too. */
  discard(id: string): void;
  /**
   * Opens the entry of a document on a text the phone kept, as the local text on the base it was written from, and
   * reconciles it with the document's draft read just now: saved if the server holds it, sent on the base if the server
   * is still there, a conflict if the server moved to another text, never a silent replacement either way. It is then
   * saved in the background, as a document no screen shows. `false`, and nothing done, if the document has an entry.
   */
  recover(document: Document, kept: KeptText): boolean;
}

const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

/** A text the app holds for a document and that the text field does not show. */
export interface HiddenText {
  text: string;
  side: Side;
  /** Whether the session holds it, in no version: then the writer may discard it. */
  discardable: boolean;
}

/**
 * The texts of an entry that the editor does not show otherwise: the other device's text of a conflict, and every text
 * the session was given and has not kept, but the one in the text field. The mobile editor has no merge view, so none
 * of them is on screen, nor is the result of a stopped "Keep mine". None while "Keep mine" runs.
 */
export const heldTexts = ({ session, autosave }: Pick<Entry, 'session' | 'autosave'>): HiddenText[] => {
  const { running, texts } = session.getSnapshot();
  if (running) return [];
  const machine = autosave.getSnapshot();
  const hidden: HiddenText[] = texts
    .filter((held) => !held.kept && held.text !== machine.content)
    .map(({ text, side }) => ({ text, side, discardable: true }));
  if (machine.status === 'conflict') {
    const text = machine.server.content;
    // The session may have kept it as a version already, or hold it: then it is not listed, or not twice.
    if (text !== machine.content && !texts.some((held) => held.text === text)) {
      hidden.unshift({ text, side: 'theirs', discardable: false });
    }
  }
  return hidden;
};

/**
 * The document a screen shows: the one read from the server, else the one the app still holds a text for (deleted
 * elsewhere, in conflict, unsaved), so that the text can always be read and copied. Undefined: neither.
 */
export const shownDocument = (drafts: Drafts, id: string, read: Document | undefined): Document | undefined =>
  read ?? drafts.get(id)?.document;

export const createDrafts = (options: DraftsOptions): Drafts => {
  const { report, onDraft, onDocument, copy, debounceMs, now = () => new Date() } = options;
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

  const create = (document: Document, base: Draft = draftOf(document)): Entry => {
    const { id } = document;
    const autosave = createAutosave({
      base,
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
    // The phone's copy follows every state of the machine, before anything else hears it.
    if (copy !== undefined) autosave.subscribe(() => copy.mirror(id, autosave.getSnapshot()));
    const session = createReconcileSession({
      id,
      autosave,
      api,
      isConflict,
      // The session's document goes to the machine here, not through a screen: when the other device wrote again
      // and no editor is shown, the entry still learns that text, and lists it. Its title is not the newest known.
      onDocument: (saved) => {
        autosave.refresh(draftOf(saved));
        const entry = entries.get(id);
        if (entry !== undefined) entry.document = { ...saved, title: entry.document.title };
        onDocument(saved, 'text');
      },
      now,
    });
    const title = createTitleSaver({
      initial: document.title,
      debounceMs,
      rename: async (value) => onDocument(await api.renameDocument(id, value), 'title'),
    });
    return { autosave, session, title, document, users: 0, opening: false };
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

  const saveVersion = async (id: string, revision: number, name?: string): Promise<Document | undefined> => {
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
          name,
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
  };

  const read = (document: Document) => {
    const entry = entries.get(document.id);
    if (entry === undefined) return;
    entry.document = document;
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
      if (entry.users === 0) entry.opening = true;
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

    saveVersion,

    async keepMine(id) {
      const { autosave, session } = entryOf(id);
      const state = autosave.getSnapshot();
      if (state.status === 'conflict') await session.confirm(state.content);
    },

    canRestore,

    async restore(id, version, head) {
      if (!canRestore(id)) return { kind: 'refused' };
      const { autosave, title } = entryOf(id);
      const text = autosave.getSnapshot().content;
      // The text on screen may be in no version: it is kept as one before it is replaced.
      if (text !== head.content) {
        let kept: Document | undefined;
        try {
          kept = await saveVersion(id, head.revision, `Before restore — ${day.format(now())}`);
        } catch (error) {
          return { kind: 'failed', error };
        }
        if (kept === undefined) {
          const state = autosave.getSnapshot();
          if (state.status === 'retrying' || state.status === 'rejected') return { kind: 'failed', error: state.error };
          return { kind: 'refused' };
        }
      }
      if (!canRestore(id) || autosave.getSnapshot().content !== text) return { kind: 'failed', error: textMoved };
      title.edit(version.title ?? '');
      autosave.edit(version.content);
      return { kind: 'restored' };
    },

    discard(id) {
      const entry = entries.get(id);
      if (entry !== undefined) drop(id, entry);
      copy?.forget(id);
    },

    recover(document, kept) {
      const { id } = document;
      if (entries.has(id)) return false;
      const entry = create(document, kept.base);
      entries.set(id, entry);
      copy?.adopt(id);
      entry.autosave.edit(kept.content);
      // Kept, never taken as the text: a draft holding another text than the kept one and its base is a conflict.
      entry.autosave.refresh(draftOf(document), true);
      release(id, entry);
      return true;
    },
  };
};
