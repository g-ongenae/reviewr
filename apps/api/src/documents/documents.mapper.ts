import type { Document, DocumentSummary, Revision, RevisionSummary } from '@reviewr/shared';
import type { DocumentRow, RevisionRow } from '../database/schema.js';

/** Columns of a document row read to list documents. */
export type DocumentSummaryRow = Pick<DocumentRow, 'id' | 'title' | 'revision' | 'createdAt' | 'updatedAt'>;

/** Columns of a revision row read to list revisions. */
export type RevisionSummaryRow = Pick<RevisionRow, 'documentId' | 'revision' | 'title' | 'createdAt'>;

/**
 * Convert a database row to its API summary representation.
 */
export const toDocumentSummary = (row: DocumentSummaryRow): DocumentSummary => ({
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
export const toRevisionSummary = (row: RevisionSummaryRow): RevisionSummary => ({
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
