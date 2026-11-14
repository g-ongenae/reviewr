import { createHash } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ConflictBody,
  Document,
  DocumentDraft,
  DocumentSummary,
  Revision,
  RevisionSummary,
} from '@reviewr/shared';
import { and, desc, eq } from 'drizzle-orm';
import { databaseToken, type Database } from '../database/database.js';
import { documentCreations, DocumentRow, documents, RevisionRow, revisions } from '../database/schema.js';
import {
  DocumentSummaryRow,
  RevisionSummaryRow,
  toDocument,
  toDocumentDraft,
  toDocumentSummary,
  toRevision,
  toRevisionSummary,
} from './documents.mapper.js';
import { CreateDocumentBodyDto } from './dto/create-document-body.dto.js';
import { CreateRevisionDto } from './dto/create-revision.dto.js';
import { NameRevisionDto } from './dto/name-revision.dto.js';
import { RenameDocumentDto } from './dto/rename-document.dto.js';
import { SaveDraftDto } from './dto/save-draft.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';

/** Revision number of the first save of a document. */
const firstRevision: number = 1;

/** Revision number of a document that has only a draft. */
const noRevision: number = 0;

/** A 409 body without the fields every 409 shares, kept discriminated by `code`. */
type ConflictDetail<T = ConflictBody> = T extends ConflictBody ? Omit<T, 'statusCode' | 'error'> : never;

/**
 * 409 with a structured body (`code` and the data the client needs to reconcile).
 */
const conflict = (detail: ConflictDetail): ConflictException =>
  new ConflictException({ statusCode: HttpStatus.CONFLICT, error: 'Conflict', ...detail } satisfies ConflictBody);

/**
 * 409 detail of a save based on a revision that is no longer the head.
 */
const staleRevision = (revision: number, baseRevision: number): ConflictDetail => ({
  code: 'stale_revision',
  message: `Document was modified elsewhere: it is at revision ${revision}, the edit is based on revision ${baseRevision}`,
  revision,
});

/**
 * Narrow an optional row, throwing a 404 when it is missing.
 */
const assertFound = <T>(row: T | undefined, id: string): T => {
  if (row === undefined) {
    throw new NotFoundException(`Document ${id} not found`);
  }

  return row;
};

/** Transaction handle of the database. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Fingerprint of a creation body as validated (a blank title is already null), to tell a creation sent again
 * from another one that reuses its id.
 */
const creationHash = (input: CreateDocumentBodyDto): string =>
  createHash('sha256')
    .update(JSON.stringify([input.title, input.content, input.draftOnly === true]))
    .digest('hex');

/**
 * Record the creation of the document `id` with a client-generated id. Answers undefined when this is the first
 * creation with this id, or the document as it is now when the same creation was already made.
 *
 * The insert of the record waits for a concurrent creation with the same id to commit or roll back, then either
 * inserts (the other one rolled back) or skips; the select after it, a new statement, sees the committed record.
 * Fails with 422 if the id was used with another body, and 410 if its document was deleted since: sending a
 * creation again never brings a deleted document back.
 */
const claimCreation = async (tx: Transaction, id: string, requestHash: string): Promise<Document | undefined> => {
  const claimed: unknown[] = await tx
    .insert(documentCreations)
    .values({ documentId: id, requestHash })
    .onConflictDoNothing()
    .returning({ documentId: documentCreations.documentId });
  if (claimed.length > 0) {
    return undefined;
  }

  const [creation] = await tx.select().from(documentCreations).where(eq(documentCreations.documentId, id));
  if (creation?.requestHash !== requestHash) {
    throw new UnprocessableEntityException(`Document ${id} was already created with another body`);
  }
  const [row] = await tx.select().from(documents).where(eq(documents.id, id));
  if (row === undefined) {
    throw new GoneException(`Document ${id} was deleted`);
  }

  return toDocument(row);
};

/**
 * Make `title` and `content` the new head revision of a locked document, and the draft equal to it.
 * `draftVersion` is bumped only if the draft text changes. `name` labels the revision (unnamed if omitted).
 */
const appendRevision = async (
  tx: Transaction,
  current: DocumentRow,
  title: DocumentRow['title'],
  content: string,
  name?: RevisionRow['name'],
): Promise<DocumentRow> => {
  const now: Date = new Date();
  const [row] = await tx
    .update(documents)
    .set({
      title,
      content,
      revision: current.revision + 1,
      draftContent: content,
      draftVersion: current.draftContent === content ? current.draftVersion : current.draftVersion + 1,
      draftBaseRevision: current.revision + 1,
      updatedAt: now,
    })
    .where(eq(documents.id, current.id))
    .returning();
  const updated: DocumentRow = assertFound(row, current.id);
  await tx.insert(revisions).values({
    documentId: current.id,
    revision: updated.revision,
    title: updated.title,
    content: updated.content,
    name,
    createdAt: now,
  });

  return updated;
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
   *
   * With `draftOnly`, no revision: the head is empty at revision 0 and the draft holds the content, based on no
   * revision (null). With a client-generated `id`, the same creation sent again answers the document as it is now
   * (see `claimCreation`); an id already taken by a document created without one is refused with 422.
   */
  public async create(input: CreateDocumentBodyDto): Promise<Document> {
    return this.db.transaction(async (tx) => {
      if (input.id !== undefined) {
        const existing: Document | undefined = await claimCreation(tx, input.id, creationHash(input));
        if (existing !== undefined) {
          return existing;
        }
      }
      const draftOnly: boolean = input.draftOnly === true;
      const [row] = await tx
        .insert(documents)
        .values({
          id: input.id,
          title: input.title,
          content: draftOnly ? '' : input.content,
          revision: draftOnly ? noRevision : firstRevision,
          draftContent: input.content,
          // eslint-disable-next-line no-null/no-null -- the draft of a document without a revision has no base
          draftBaseRevision: draftOnly ? null : firstRevision,
        })
        .onConflictDoNothing()
        .returning();
      if (row === undefined) {
        throw new UnprocessableEntityException(`Document ${input.id ?? 'new'} already exists`);
      }
      if (draftOnly) {
        return toDocument(row);
      }
      const created: DocumentRow = row;
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
   * Fails with 409 `stale_revision` if the document was saved since `baseRevision` (optimistic locking),
   * so that concurrent edits from two devices never silently overwrite each other. Saving identical
   * content is a no-op and does not create a revision. Otherwise the draft is replaced by the saved
   * content and based on the new revision; `draftVersion` is bumped only if the draft text changed.
   *
   * An autosaved draft that differs from both the head and the saved content is never overwritten: it
   * is first committed as a revision of its own, then the save fails with 409 `stale_revision` at that
   * new revision. To a client that knows only revisions this is "changed elsewhere": it reloads the
   * draft text, or retries on the new revision with the draft kept in the history.
   *
   * A document without a revision yet looks to such a client like an empty text at revision 0. Its save, based
   * on 0, becomes revision 1; a draft it never saw, and that the save would overwrite, is kept first, as above.
   */
  public async update(id: string, input: UpdateDocumentDto): Promise<Document> {
    const result: Document | ConflictDetail = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(documents).where(eq(documents.id, id)).for('update');
      const current: DocumentRow = assertFound(locked, id);

      if (current.revision !== input.baseRevision) {
        throw conflict(staleRevision(current.revision, input.baseRevision));
      }
      if (current.title === input.title && current.content === input.content) {
        return toDocument(current);
      }
      if (current.draftContent !== current.content && current.draftContent !== input.content) {
        // Returned, not thrown: throwing would roll the promotion of the draft back.
        const promoted: DocumentRow = await appendRevision(tx, current, current.title, current.draftContent);

        return staleRevision(promoted.revision, input.baseRevision);
      }

      return toDocument(await appendRevision(tx, current, input.title, input.content));
    });

    if ('code' in result) {
      throw conflict(result);
    }

    return result;
  }

  /**
   * Autosave the draft of a document. Creates no revision and leaves the head (`content`, `revision`)
   * and the draft's base revision alone.
   *
   * Saving the text already stored answers the current draft and changes nothing, whatever
   * `draftVersion` it carries: a retry after a lost response must not conflict with itself.
   * Otherwise it fails with 409 `draft_conflict` if the draft was saved since `draftVersion`, with the
   * current draft in the body so the client can reconcile without another request.
   * A save moves `updatedAt`, so documents being written rise in the list.
   */
  public async saveDraft(id: string, input: SaveDraftDto): Promise<DocumentDraft> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(documents).where(eq(documents.id, id)).for('update');
      const current: DocumentRow = assertFound(locked, id);

      if (current.draftContent === input.content) {
        return toDocumentDraft(current);
      }
      if (current.draftVersion !== input.draftVersion) {
        throw conflict({
          code: 'draft_conflict',
          message: `Draft was modified elsewhere: it is at version ${current.draftVersion}, the edit is based on version ${input.draftVersion}`,
          draft: toDocumentDraft(current),
        });
      }

      const [row] = await tx
        .update(documents)
        .set({ draftContent: input.content, draftVersion: current.draftVersion + 1, updatedAt: new Date() })
        .where(eq(documents.id, id))
        .returning();

      return toDocumentDraft(assertFound(row, id));
    });
  }

  /**
   * Save the draft of a document as a new version: a revision holding the draft text, the document's
   * current title and `name`. The head becomes that revision and the draft is based on it.
   *
   * The checks run in this order, under the row lock. First, 409 `draft_conflict` (with the server's draft)
   * if the draft moved since `draftVersion`: the client sends no text, so it must never be told "saved" for a
   * text it has not seen. Then a no-op if the draft text already is the head: it answers the document and
   * creates no revision, and the `name` is ignored (naming an existing version is another endpoint). This
   * makes a retry after a lost response safe: the first call made the draft the head without bumping
   * `draftVersion`, so the retry passes the first check and stops here, although its `baseRevision` is now
   * one behind. (If the draft text changed meanwhile, `draftVersion` advanced and the retry gets
   * `draft_conflict`; the version it asked for is in the history.) Last, 409 `stale_revision` if the head
   * moved since `baseRevision`.
   *
   * So a success says that the draft text of `draftVersion` is the head, not that this call created the
   * revision or applied its `name`.
   *
   * On a document without a revision yet, the base is null or 0, and the version saved is revision 1. An empty
   * draft there is the (empty) head, so it is a no-op: no empty first version.
   */
  public async createRevision(id: string, input: CreateRevisionDto): Promise<Document> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(documents).where(eq(documents.id, id)).for('update');
      const current: DocumentRow = assertFound(locked, id);

      if (current.draftVersion !== input.draftVersion) {
        throw conflict({
          code: 'draft_conflict',
          message: `Draft was modified elsewhere: it is at version ${current.draftVersion}, the version is based on draft version ${input.draftVersion}`,
          draft: toDocumentDraft(current),
        });
      }
      if (current.draftContent === current.content) {
        return toDocument(current);
      }
      const baseRevision: number = input.baseRevision ?? noRevision;
      if (current.revision !== baseRevision) {
        throw conflict(staleRevision(current.revision, baseRevision));
      }

      return toDocument(await appendRevision(tx, current, current.title, current.draftContent, input.name));
    });
  }

  /**
   * Rename a document. Creates no revision and leaves the content, the draft and `draftVersion` alone: the
   * title is a label, not text, so the last rename wins. The revisions already saved keep the title they were
   * saved with (they are snapshots). The next version saved from the draft (`POST /documents/:id/revisions`,
   * or a draft kept as a revision by the old `PUT`) takes the new title. A rename moves `updatedAt`, like an
   * autosave, so the list shows it first; sending the title already stored changes nothing.
   *
   * Known limit: `PUT /documents/:id` always carries a title and applies it, as before. So an app that loaded
   * the document before a rename puts the old title back with its next save: the server cannot tell that
   * title from one the writer chose. This ends for an app once it renames through this endpoint and stops
   * sending a cached title; builds already installed keep the limit.
   */
  public async rename(id: string, input: RenameDocumentDto): Promise<Document> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(documents).where(eq(documents.id, id)).for('update');
      const current: DocumentRow = assertFound(locked, id);
      if (current.title === input.title) {
        return toDocument(current);
      }

      const [row] = await tx
        .update(documents)
        .set({ title: input.title, updatedAt: new Date() })
        .where(eq(documents.id, id))
        .returning();

      return toDocument(assertFound(row, id));
    });
  }

  /**
   * Set or clear the label of a saved version. Its content and title are immutable and stay as they are, and
   * the document (including `updatedAt`) is not touched. The last label sent wins.
   */
  public async nameRevision(
    documentId: string,
    revisionNumber: number,
    input: NameRevisionDto,
  ): Promise<RevisionSummary> {
    const [row] = await this.db
      .update(revisions)
      .set({ name: input.name })
      .where(and(eq(revisions.documentId, documentId), eq(revisions.revision, revisionNumber)))
      .returning({
        documentId: revisions.documentId,
        revision: revisions.revision,
        title: revisions.title,
        name: revisions.name,
        createdAt: revisions.createdAt,
      });
    if (row === undefined) {
      await this.get(documentId);
      throw new NotFoundException(`Revision ${revisionNumber} of document ${documentId} not found`);
    }

    return toRevisionSummary(row);
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
        name: revisions.name,
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
