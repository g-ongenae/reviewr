/**
 * Lightweight representation of a document, used in listings.
 * Dates are ISO 8601 strings.
 */
export interface DocumentSummary {
  id: string;
  title: string;
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
}

/**
 * Metadata of an immutable snapshot of a document.
 */
export interface RevisionSummary {
  documentId: string;
  revision: number;
  title: string;
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
  title: string;
  content: string;
}

/**
 * Payload to save a new version of a document.
 */
export interface UpdateDocumentInput {
  title: string;
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
