import { createHash } from 'node:crypto';
import { GoneException, UnprocessableEntityException } from '@nestjs/common';
import type { Document } from '@reviewr/shared';
import { eq } from 'drizzle-orm';
import type { Transaction } from '../database/database.js';
import { documentCreations, documents, revisionRequests } from '../database/schema.js';
import { toDocument } from './documents.mapper.js';
import type { CreateDocumentBodyDto } from './dto/create-document-body.dto.js';
import type { CreateRevisionDto } from './dto/create-revision.dto.js';

/*
 * Requests that can be sent again safely: a creation with a client-generated id (`DocumentsService.create`), and a
 * version with an idempotency key (`DocumentsService.createRevision`). Each records what it made, under a key.
 *
 * Every creation is recorded, also when the server chooses the id, and the record outlives the document: no document
 * is ever created under the id of another one, so a client that still holds something of a deleted document under
 * its id (a cache, a local buffer, an answer still on its way) can never take it for a new document.
 */

/**
 * Fingerprint of a creation body as validated (a blank title is already null), to tell a creation sent again
 * from another one that reuses its id.
 */
export const creationHash = (input: CreateDocumentBodyDto): string =>
  createHash('sha256')
    .update(JSON.stringify([input.title, input.content, input.draftOnly === true]))
    .digest('hex');

/**
 * Reserve `id` before creating its document. Answers undefined when this is the first
 * creation with this id, or the document as it is now when the same creation was already made.
 *
 * The insert of the record waits for a concurrent creation with the same id to commit or roll back, then either
 * inserts (the other one rolled back) or skips; the select after it, a new statement, sees the committed record.
 * Fails with 422 if the id was used with another body, and 410 if its document was deleted since: sending a
 * creation again never brings a deleted document back.
 *
 * An id the server chose (a record without hash, see the insert below, or one added by migration 0005 for the
 * documents that existed then) is never the same creation: 422 while its document exists, 410 once it is deleted.
 * A deletion never removes the record, so whichever of a delete and this creation commits first, the outcome is one
 * of these answers, never a new document under that id.
 */
export const reserveCreation = async (
  tx: Transaction,
  id: string,
  input: CreateDocumentBodyDto,
): Promise<Document | undefined> => {
  if (input.id === undefined) {
    // Reserve the UUID before inserting the document. A collision fails instead of reusing an id.
    await tx.insert(documentCreations).values({ documentId: id });

    return undefined;
  }
  const requestHash: string = creationHash(input);
  const claimed: unknown[] = await tx
    .insert(documentCreations)
    .values({ documentId: id, requestHash })
    .onConflictDoNothing()
    .returning({ documentId: documentCreations.documentId });
  if (claimed.length > 0) {
    return undefined;
  }

  const [creation] = await tx.select().from(documentCreations).where(eq(documentCreations.documentId, id));
  const [row] = await tx.select().from(documents).where(eq(documents.id, id));
  // eslint-disable-next-line no-null/no-null -- a record without hash is a creation whose id the server chose
  const serverChosen: boolean = creation?.requestHash === null;
  if (serverChosen && row !== undefined) {
    throw new UnprocessableEntityException(`Document ${id} already exists`);
  }
  if (!serverChosen && creation?.requestHash !== requestHash) {
    throw new UnprocessableEntityException(`Document ${id} was already created with another body`);
  }
  if (row === undefined) {
    throw new GoneException(`Document ${id} was deleted`);
  }

  return toDocument(row);
};

/**
 * Fingerprint of a version request as validated (a blank name is already null, a null base is 0), with its document,
 * to tell the same request sent again from another one that reuses its idempotency key.
 */
export const revisionRequestHash = (documentId: string, input: CreateRevisionDto): string =>
  createHash('sha256')
    .update(JSON.stringify([documentId, input.draftVersion, input.baseRevision ?? 0, input.name]))
    .digest('hex');

/**
 * Revision recorded for the idempotency key `key`, or undefined if the key is unknown. Fails with 422 if the key
 * was recorded for another request. Called under the row lock of the document: a request with the same key that
 * held it before has committed its record, which this new statement sees.
 */
export const recordedRevision = async (
  tx: Transaction,
  key: string,
  requestHash: string,
): Promise<number | undefined> => {
  const [record] = await tx.select().from(revisionRequests).where(eq(revisionRequests.idempotencyKey, key));
  if (record === undefined) {
    return undefined;
  }
  if (record.requestHash !== requestHash) {
    throw new UnprocessableEntityException(`Idempotency key ${key} was already used for another request`);
  }

  return record.revision;
};

/**
 * Record that the request with the idempotency key `key` saved its text as `revision`. Fails with 422 (and the
 * transaction, revision included, rolls back) if a request on another document recorded the same key meanwhile.
 */
export const recordRevision = async (
  tx: Transaction,
  key: string,
  requestHash: string,
  documentId: string,
  revision: number,
): Promise<void> => {
  const recorded: unknown[] = await tx
    .insert(revisionRequests)
    .values({ idempotencyKey: key, documentId, revision, requestHash })
    .onConflictDoNothing()
    .returning({ idempotencyKey: revisionRequests.idempotencyKey });
  if (recorded.length === 0) {
    throw new UnprocessableEntityException(`Idempotency key ${key} was already used for another request`);
  }
};
