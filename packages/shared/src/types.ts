/**
 * Lightweight representation of a document, used in listings.
 * Dates are ISO 8601 strings.
 */
export interface DocumentSummary {
  id: string;
  title: string | null;
  /** Number of the latest revision (starts at 1, incremented on every content change). */
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
 * Structured body of a 409 Conflict, discriminated by `code`.
 */
export type ConflictBody = DraftConflictBody | StaleRevisionBody;

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
   */
  baseRevision: number;
}
