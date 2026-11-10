import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Document, DocumentSummary, Revision, RevisionSummary } from '@reviewr/shared';
import { and, desc, eq } from 'drizzle-orm';
import { databaseToken, type Database } from '../database/database.js';
import { DocumentRow, documents, revisions } from '../database/schema.js';
import {
  DocumentSummaryRow,
  RevisionSummaryRow,
  toDocument,
  toDocumentSummary,
  toRevision,
  toRevisionSummary,
} from './documents.mapper.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';

/** Revision number of the first save of a document. */
const firstRevision: number = 1;

/**
 * Narrow an optional row, throwing a 404 when it is missing.
 */
const assertFound = <T>(row: T | undefined, id: string): T => {
  if (row === undefined) {
    throw new NotFoundException(`Document ${id} not found`);
  }

  return row;
};

/**
 * Stores documents and keeps an append-only history of their revisions.
 */
@Injectable()
export class DocumentsService {
  /**
   * @param db - Drizzle database
   */
  constructor(@Inject(databaseToken) private readonly db: Database) {}

  /**
   * List documents, most recently updated first.
   */
  public async list(): Promise<DocumentSummary[]> {
    const rows: DocumentSummaryRow[] = await this.db
      .select({
        id: documents.id,
        title: documents.title,
        revision: documents.revision,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .orderBy(desc(documents.updatedAt));

    return rows.map(toDocumentSummary);
  }

  /**
   * Get a document with its current content.
   */
  public async get(id: string): Promise<Document> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, id));

    return toDocument(assertFound(row, id));
  }

  /**
   * Create a document and its first revision. The draft starts equal to that revision.
   */
  public async create(input: CreateDocumentDto): Promise<Document> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(documents)
        .values({
          title: input.title,
          content: input.content,
          revision: firstRevision,
          draftContent: input.content,
          draftBaseRevision: firstRevision,
        })
        .returning();
      const created: DocumentRow = assertFound(row, 'new');
      await tx.insert(revisions).values({
        documentId: created.id,
        revision: created.revision,
        title: created.title,
        content: created.content,
        createdAt: created.createdAt,
      });

      return toDocument(created);
    });
  }

  /**
   * Save a new version of a document.
   *
   * Fails with 409 if the document was saved since `baseRevision` (optimistic locking), so that
   * concurrent edits from two devices never silently overwrite each other. Saving identical
   * content is a no-op and does not create a revision. Otherwise the draft is replaced by the saved
   * content and based on the new revision; `draftVersion` is bumped only if the draft text changed.
   */
  public async update(id: string, input: UpdateDocumentDto): Promise<Document> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(documents).where(eq(documents.id, id)).for('update');
      const current: DocumentRow = assertFound(locked, id);

      if (current.revision !== input.baseRevision) {
        throw new ConflictException(
          `Document was modified elsewhere: it is at revision ${current.revision}, the edit is based on revision ${input.baseRevision}`,
        );
      }
      if (current.title === input.title && current.content === input.content) {
        return toDocument(current);
      }

      const now: Date = new Date();
      const [row] = await tx
        .update(documents)
        .set({
          title: input.title,
          content: input.content,
          revision: current.revision + 1,
          draftContent: input.content,
          draftVersion: current.draftContent === input.content ? current.draftVersion : current.draftVersion + 1,
          draftBaseRevision: current.revision + 1,
          updatedAt: now,
        })
        .where(eq(documents.id, id))
        .returning();
      const updated: DocumentRow = assertFound(row, id);
      await tx.insert(revisions).values({
        documentId: id,
        revision: updated.revision,
        title: updated.title,
        content: updated.content,
        createdAt: now,
      });

      return toDocument(updated);
    });
  }

  /**
   * Delete a document and its whole history.
   */
  public async delete(id: string): Promise<void> {
    const deleted: { id: string }[] = await this.db
      .delete(documents)
      .where(eq(documents.id, id))
      .returning({ id: documents.id });
    assertFound(deleted[0], id);
  }

  /**
   * List the revisions of a document, newest first.
   */
  public async listRevisions(documentId: string): Promise<RevisionSummary[]> {
    await this.get(documentId);
    const rows: RevisionSummaryRow[] = await this.db
      .select({
        documentId: revisions.documentId,
        revision: revisions.revision,
        title: revisions.title,
        createdAt: revisions.createdAt,
      })
      .from(revisions)
      .where(eq(revisions.documentId, documentId))
      .orderBy(desc(revisions.revision));

    return rows.map(toRevisionSummary);
  }

  /**
   * Get a single revision of a document, with its content.
   */
  public async getRevision(documentId: string, revisionNumber: number): Promise<Revision> {
    const [row] = await this.db
      .select()
      .from(revisions)
      .where(and(eq(revisions.documentId, documentId), eq(revisions.revision, revisionNumber)));
    if (row === undefined) {
      throw new NotFoundException(`Revision ${revisionNumber} of document ${documentId} not found`);
    }

    return toRevision(row);
  }
}
