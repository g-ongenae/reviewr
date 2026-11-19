/**
 * Lightweight representation of a document, used in listings.
 * Dates are ISO 8601 strings.
 */
export interface DocumentSummary {
  id: string;
  title: string | null;
  /**
   * Number of the latest revision (starts at 1, incremented on every content change). 0 when the document has
   * no revision yet (created with `draftOnly`): its `content` is then empty and its text is in the draft.
   */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A document with its current content.
 */
export interface Document extends DocumentSummary {
  content: string;
  /**
   * Autosaved text of the document. The API always sends it; it is optional only so clients and
   * fixtures written before drafts existed keep compiling.
   */
  draft?: DocumentDraft;
}

/**
 * Metadata of an immutable snapshot of a document.
 */
export interface RevisionSummary {
  documentId: string;
  revision: number;
  title: string | null;
  /** Version label given when the version was saved, separate from the title; null when unnamed. */
  name: string | null;
  createdAt: string;
}

/**
 * An immutable snapshot of a document, taken each time it is saved with changes.
 */
export interface Revision extends RevisionSummary {
  content: string;
}

/**
 * Payload to create a document.
 */
export interface CreateDocumentInput {
  title?: string | null;
  content: string;
}

/**
 * Payload to save a new version of a document.
 */
export interface UpdateDocumentInput {
  title?: string | null;
  content: string;
  /**
   * Revision the client started editing from. If the document has been saved
   * elsewhere in the meantime (e.g. from another device), the API answers 409 Conflict
   * instead of silently overwriting the other change.
   */
  baseRevision: number;
}

/**
 * Error body returned by the API.
 */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  error?: string;
}

/**
 * Autosaved text of a document, not yet a revision.
 */
export interface DocumentDraft {
  content: string;
  /** Incremented on every change of the draft; send it back with the next save to detect conflicts. */
  draftVersion: number;
  /** Revision the draft was started from; null when the document has no revision yet. */
  baseRevision: number | null;
}

/**
 * Payload of `PUT /documents/:id/draft` (autosave).
 */
export interface SaveDraftInput {
  content: string;
  /**
   * `draftVersion` the edits started from. If the draft was saved elsewhere in the meantime,
   * the API answers 409 with a `DraftConflictBody` instead of overwriting it, unless `content`
   * already is the stored draft (a retry), which answers the current draft.
   */
  draftVersion: number;
}

/**
 * 409 of `PUT /documents/:id/draft`: the draft moved since `draftVersion`. Carries the server's draft.
 */
export interface DraftConflictBody extends ApiErrorBody {
  code: 'draft_conflict';
  draft: DocumentDraft;
}

/**
 * 409 of `PUT /documents/:id`: the document was saved since `baseRevision`, or it had an autosaved draft
 * that the save would have overwritten, which the server committed as revision `revision` first.
 */
export interface StaleRevisionBody extends ApiErrorBody {
  code: 'stale_revision';
  /** Current revision of the document. */
  revision: number;
}

/**
 * What a client last saw of a document, sent with `DELETE /documents/:id` so that a delete made from a stale view
 * never destroys text saved since on another device.
 */
export interface DeleteDocumentInput {
  /** Head revision the client last saw (0 for a document without a revision yet). */
  revision: number;
  /** `draftVersion` of the draft the client last saw. */
  draftVersion: number;
}

/**
 * 409 of `DELETE /documents/:id` with a `DeleteDocumentInput`: the head or the draft moved since the client read
 * them, and nothing was deleted. Carries what the server holds now.
 */
export interface DocumentChangedBody extends ApiErrorBody {
  code: 'document_changed';
  /** Current head revision of the document (0 without a revision yet). */
  revision: number;
  /** Current draft of the document. */
  draft: DocumentDraft;
}

/**
 * Structured body of a 409 Conflict, discriminated by `code`.
 */
export type ConflictBody = DraftConflictBody | StaleRevisionBody | DocumentChangedBody;

/**
 * Payload of `POST /documents/:id/revisions`: save the server's draft as a new version.
 */
export interface CreateRevisionInput {
  /** Version label; trimmed, and a blank one is stored as null. Ignored when the draft already is the head. */
  name?: string | null;
  /** `draftVersion` of the draft to save. If the draft moved since, the API answers 409 `draft_conflict`. */
  draftVersion: number;
  /**
   * Head revision the draft is based on. If the head moved since, the API answers 409 `stale_revision`,
   * unless the draft already is the head: then there is nothing to save and the document is answered.
   * For a document without a revision yet, null (the draft's `baseRevision`) or 0 (the document's `revision`).
   */
  baseRevision: number | null;
  /**
   * Key chosen by the client, a UUID (e.g. `crypto.randomUUID()`), that makes the request safe to send again after
   * a lost answer: keep it with the request, and use a new one for every other version. Optional: without it, the
   * request is decided on the draft and the head as they are when it arrives (see above).
   *
   * The first success with a key records it with the revision that holds the draft text of `draftVersion` (the one
   * created, or the head when the draft already was the head). The same request sent again, with the same key,
   * answers success and that revision in `savedRevision`, whatever happened since (text autosaved, other versions
   * saved, a rename), and creates nothing. The same key with another request (another document, `draftVersion`,
   * `baseRevision` or name) is refused with 422, and nothing is created. A refusal (409, 404, 400) records nothing:
   * the same request sent again is decided again, by the same checks. A record goes with its document: once the
   * document is deleted, the same request is answered 404.
   */
  idempotencyKey?: string;
}

/**
 * Answer of `POST /documents/:id/revisions`: the document as it is now (head and draft), and, when the request carried
 * an `idempotencyKey`, the revision that holds the text it asked to save.
 */
export interface SavedVersion extends Document {
  /**
   * Present only when the request carried an `idempotencyKey`. The number of the revision that holds the draft text
   * of the request's `draftVersion`: it exists, although the head may have moved past it since. Null only when
   * there was nothing to save: an empty draft on a document without a revision (no revision is created then, and
   * the key is not recorded).
   */
  savedRevision?: number | null;
}

/**
 * Payload of `PATCH /documents/:id`: rename a document. Creates no revision and leaves the content and the draft
 * alone; the revisions already saved keep the title they were saved with.
 */
export interface RenameDocumentInput {
  /** New title, kept as typed. Null, empty or blank makes the document untitled. Required: send null to clear. */
  title: string | null;
}

/**
 * Payload of `PATCH /documents/:id/revisions/:revision`: set or clear the label of a saved version.
 */
export interface NameRevisionInput {
  /** Version label, trimmed. Null, empty or blank removes it. Required: send null to clear. */
  name: string | null;
}

/**
 * Payload of `POST /documents` that creates a document with only a draft, safe to send again: what the Composer
 * sends on its first autosave, possibly from an outbox. No revision is created (`revision` is 0, `content` is
 * empty, the draft holds `content` at `draftVersion` 1 with `baseRevision` null).
 *
 * The same request sent again (a lost answer, a replay) answers the same document as it is now, never a second
 * one. The same `id` with another body is refused with 422, and an `id` whose document was deleted since with
 * 410: a replay never brings a deleted document back.
 */
export interface CreateDraftDocumentInput extends CreateDocumentInput {
  /** Document id generated by the client, a UUID (e.g. `crypto.randomUUID()`); keep it to send the creation again. */
  id: string;
  /** Create no revision: the content is the draft only. */
  draftOnly: true;
}
