import type { Document, DocumentSummary, Revision, RevisionSummary } from '@reviewr/shared';
import type { DocumentRow, RevisionRow } from '../database/schema.js';

/**
 * Convert a database row to its API summary representation.
 */
export const toDocumentSummary = (row: Omit<DocumentRow, 'content'>): DocumentSummary => ({
  id: row.id,
  title: row.title,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Convert a database row to its API representation.
 */
export const toDocument = (row: DocumentRow): Document => ({
  ...toDocumentSummary(row),
  content: row.content,
});

/**
 * Convert a revision row to its API summary representation.
 */
export const toRevisionSummary = (row: Omit<RevisionRow, 'content'>): RevisionSummary => ({
  documentId: row.documentId,
  revision: row.revision,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Convert a revision row to its API representation.
 */
export const toRevision = (row: RevisionRow): Revision => ({
  ...toRevisionSummary(row),
  content: row.content,
});
