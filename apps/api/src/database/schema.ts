import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Current state of each document. `content`/`title` mirror the latest revision so
 * reading a document never needs a join. The `draft*` columns hold the autosaved text, which
 * can move ahead of the latest revision.
 */
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
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
    title: text('title').notNull(),
    content: text('content').notNull(),
    /** Optional version label, separate from the document title. */
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.revision] })],
);

export type DocumentRow = typeof documents.$inferSelect;
export type RevisionRow = typeof revisions.$inferSelect;
