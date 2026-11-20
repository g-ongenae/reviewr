import { foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Current state of each document. `content`/`title` mirror the latest revision so
 * reading a document never needs a join. The `draft*` columns hold the autosaved text, which
 * can move ahead of the latest revision.
 */
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title'),
  content: text('content').notNull(),
  revision: integer('revision').notNull().default(1),
  /** Autosaved text, not yet a revision. Equal to `content` when nothing is pending. */
  draftContent: text('draft_content').notNull(),
  /** Incremented on every change of the draft; a write based on a stale value is a conflict. */
  draftVersion: integer('draft_version').notNull().default(1),
  /** Revision the draft was started from; null when the document has no revision yet. */
  draftBaseRevision: integer('draft_base_revision'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Immutable snapshot of a document, appended every time it is saved with changes.
 */
export const revisions = pgTable(
  'revisions',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    title: text('title'),
    content: text('content').notNull(),
    /** Optional version label, separate from the document title. */
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.revision] })],
);

/**
 * One row per document ever created, whoever chose its id, kept after the document is deleted (no foreign key), so
 * that no document is ever created again under the id of another one. A creation with a client-generated id
 * (`POST /documents` with `id`) sent again is recognised: the same body answers the document instead of creating a
 * second one, a different body is refused, and a deleted document is answered as gone rather than created again.
 * Documents that existed before migration 0005 got a row from it; those deleted before it left none.
 */
export const documentCreations = pgTable('document_creations', {
  documentId: uuid('document_id').primaryKey(),
  /**
   * SHA-256 (hex) of the creation body as validated: title, content and `draftOnly`. Null when the server chose the
   * id: no request can be the same creation sent again.
   */
  requestHash: text('request_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per version saved with an idempotency key (`POST /documents/:id/revisions` with `idempotencyKey`): the
 * revision that holds the text the request asked to save, so that the same request sent again answers that
 * revision instead of creating a second one. The foreign key to the revision makes a record impossible without
 * its revision: deleting the document deletes its revisions and these records with them.
 */
export const revisionRequests = pgTable(
  'revision_requests',
  {
    idempotencyKey: uuid('idempotency_key').primaryKey(),
    documentId: uuid('document_id').notNull(),
    revision: integer('revision').notNull(),
    /** SHA-256 (hex) of the request as validated: document id, `draftVersion`, `baseRevision` and name. */
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'revision_requests_revision_fk',
      columns: [table.documentId, table.revision],
      foreignColumns: [revisions.documentId, revisions.revision],
    }).onDelete('cascade'),
    // The cascade looks the records of each deleted revision up.
    index('revision_requests_revision_idx').on(table.documentId, table.revision),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
export type RevisionRow = typeof revisions.$inferSelect;
