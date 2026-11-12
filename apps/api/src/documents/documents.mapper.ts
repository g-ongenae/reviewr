import type { Document, DocumentDraft, DocumentSummary, Revision, RevisionSummary } from '@reviewr/shared';
import type { DocumentRow, RevisionRow } from '../database/schema.js';

/** Columns of a document row read to list documents. */
export type DocumentSummaryRow = Pick<DocumentRow, 'id' | 'title' | 'revision' | 'createdAt' | 'updatedAt'>;

/** Columns of a revision row read to list revisions. */
export type RevisionSummaryRow = Pick<RevisionRow, 'documentId' | 'revision' | 'title' | 'name' | 'createdAt'>;

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
 * Extract the draft of a document row.
 */
export const toDocumentDraft = (row: DocumentRow): DocumentDraft => ({
  content: row.draftContent,
  draftVersion: row.draftVersion,
  baseRevision: row.draftBaseRevision,
});

/**
 * Convert a database row to its API representation.
 */
export const toDocument = (row: DocumentRow): Document => ({
  ...toDocumentSummary(row),
  content: row.content,
  draft: toDocumentDraft(row),
});

/**
 * Convert a revision row to its API summary representation.
 */
export const toRevisionSummary = (row: RevisionSummaryRow): RevisionSummary => ({
  documentId: row.documentId,
  revision: row.revision,
  title: row.title,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Convert a revision row to its API representation.
 */
export const toRevision = (row: RevisionRow): Revision => ({
  ...toRevisionSummary(row),
  content: row.content,
});
