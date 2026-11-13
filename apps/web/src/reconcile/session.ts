import type { CreateRevisionInput, Document, DocumentDraft, SaveDraftInput } from '@reviewr/shared';
import type { Autosave, Draft } from '../autosave/autosave';

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export type Side = 'mine' | 'theirs';

/** The name of a version a reconciliation keeps: the side its text comes from, and the day ("This device — 13 Nov"). */
export const versionName = (side: Side, date: Date): string =>
  `${side === 'mine' ? 'This device' : 'Other device'} — ${day.format(date)}`;

/** The requests a session sends. */
export interface SessionApi {
  getDocument(id: string): Promise<Document>;
  saveDraft(id: string, input: SaveDraftInput): Promise<DocumentDraft>;
  createRevision(id: string, input: CreateRevisionInput): Promise<Document>;
}

/** Why the last confirmation stopped without applying its result. */
export type Stop =
  /** The other device wrote a text the writer has not reconciled with: the view now shows it. */
  | { reason: 'moved' }
  /** A request failed. */
  | { reason: 'failed'; error: unknown }
  /** The local text changed while the confirmation ran: the result was not applied over it. */
  | { reason: 'changed' };

export interface SessionState {
  /** A confirmation is running: nothing may change the texts until it ends. */
  running: boolean;
  /** The text the writer confirmed, until it is applied or the writer discards it. */
  result?: string;
  stop?: Stop;
}

export interface ReconcileSession {
  getSnapshot(): SessionState;
  subscribe(listener: () => void): () => void;
  /**
   * Keeps every text the session was given and that `result` would replace, then applies `result` through the
   * machine's `resolve`. Ignored while a confirmation runs, or when the machine is not in conflict. Never rejects.
   */
  confirm(result: string): Promise<void>;
  /** The writer discards the result of a stopped confirmation. */
  dismissResult(): void;
}

export interface SessionOptions {
  id: string;
  autosave: Autosave;
  api: SessionApi;
  /** Whether an error is a 409: the server moved since the request was built. */
  isConflict: (error: unknown) => boolean;
  /**
   * Receives the server's document when a confirmation ends by applying its result or because the other device wrote
   * again (then its draft is that device's newest text, which the machine takes as the conflict's text).
   */
  onDocument: (document: Document) => void;
  now?: () => Date;
}

interface Given {
  text: string;
  side: Side;
}

const draftOf = (document: Document): Draft => {
  const { content, draftVersion } = document.draft ?? { content: document.content, draftVersion: 1 };
  return { content, draftVersion };
};

/**
 * The reconciliation of one document's draft conflict. It lives as long as the machine, outside the editor, so a
 * confirmation started in an editor that was left ends the same way, and its result stays recoverable.
 *
 * The rule: before the result is applied, every text the session was given (each local text and each other device's
 * text it was confirmed with) is the result itself or verifiably kept. A text counts as kept only when the session saw
 * it as the head, or got a success for the snapshot of a draft it had just read or written as that text; never
 * because the server's draft happens to hold it. A text that is no longer the draft is written back, then snapshotted.
 * And no request overwrites a draft that is not kept, not even one that holds the result (the writer may still
 * discard it).
 */
export const createReconcileSession = (options: SessionOptions): ReconcileSession => {
  const { id, autosave, api, isConflict, onDocument, now = () => new Date() } = options;

  /** The texts the session was given, in order: they must be kept before a result is applied. */
  let given: Given[] = [];
  /** The texts this session verifiably kept. */
  let kept = new Set<string>();
  let state: SessionState = { running: false };
  const listeners = new Set<() => void>();

  const set = (next: SessionState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const give = (text: string, side: Side) => {
    if (!given.some((item) => item.text === text)) given.push({ text, side });
  };

  type Outcome = { kind: 'apply'; document: Document } | { kind: 'moved'; document: Document };

  /** The requests: makes every given text kept, then answers whether the result can be applied. */
  const keepAll = async (result: string): Promise<Outcome> => {
    const sideOf = (text: string): Side => given.find((item) => item.text === text)?.side ?? 'theirs';
    /** A text the writer has seen: one given, kept, or the result. */
    const known = (text: string) => text === result || kept.has(text) || given.some((item) => item.text === text);

    let document = await api.getDocument(id);
    /** The newest draft of the other device that the writer has not seen. */
    let newest: string | undefined;

    /** Makes the draft just read or written a version. */
    const snapshot = async () => {
      const { content, draftVersion } = draftOf(document);
      document = await api.createRevision(id, {
        name: versionName(sideOf(content), now()),
        draftVersion,
        baseRevision: document.revision,
      });
      kept.add(content);
    };

    // Each pass sends one request at most; the limit only stops a server that keeps changing.
    const limit = 4 * given.length + 12;
    for (let pass = 0; pass < limit; pass++) {
      try {
        const draft = draftOf(document).content;
        kept.add(document.content);
        if (!known(draft)) newest = draft;
        const missing = given.find((item) => item.text !== result && !kept.has(item.text));
        // What the draft must hold next: a text to keep, the other device's newest text to give back, or the result.
        const target = missing?.text ?? newest;
        if (target === undefined) {
          if (draft === result || kept.has(draft)) return { kind: 'apply', document };
          await snapshot();
        } else if (draft === target) {
          if (missing === undefined) return { kind: 'moved', document };
          await snapshot();
        } else if (!kept.has(draft)) {
          // The draft is about to be overwritten: it is kept first, even when it is the result, which the writer may
          // still discard.
          await snapshot();
        } else {
          const saved = await api.saveDraft(id, { content: target, draftVersion: draftOf(document).draftVersion });
          document = { ...document, draft: saved };
        }
      } catch (error) {
        if (!isConflict(error)) throw error;
        document = await api.getDocument(id);
      }
    }
    throw new Error('The text kept changing on the server');
  };

  return {
    getSnapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async confirm(result) {
      const machine = autosave.getSnapshot();
      if (state.running || machine.status !== 'conflict') return;
      const mine = machine.content;
      give(machine.server.content, 'theirs');
      give(mine, 'mine');
      set({ running: true, result });
      let outcome: Outcome;
      try {
        outcome = await keepAll(result);
      } catch (error) {
        set({ running: false, result, stop: { reason: 'failed', error } });
        return;
      }
      if (outcome.kind === 'moved') {
        onDocument(outcome.document);
        set({ running: false, result, stop: { reason: 'moved' } });
        return;
      }
      const current = autosave.getSnapshot();
      if (current.status !== 'conflict' || current.content !== mine) {
        set({ running: false, result, stop: { reason: 'changed' } });
        return;
      }
      autosave.resolve(result, draftOf(outcome.document));
      // Applied: every text is the result or kept, so the session forgets them.
      given = [];
      kept = new Set();
      onDocument(outcome.document);
      set({ running: false });
    },

    dismissResult() {
      if (state.running || state.result === undefined) return;
      set({ running: false });
    },
  };
};

const sessions = new WeakMap<Autosave, ReconcileSession>();

/** The session of a document's machine, created on first use; it lives as long as the machine. */
export const sessionFor = (options: SessionOptions): ReconcileSession => {
  let session = sessions.get(options.autosave);
  if (session === undefined) {
    session = createReconcileSession(options);
    sessions.set(options.autosave, session);
  }
  return session;
};
