/* eslint-disable no-null/no-null -- an unnamed version is sent as null, as the API does */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import type { Document } from '@reviewr/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/database/schema.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { closeTestDatabase, openTestDatabase, serverUrl, setupTimeout, type TestDatabase } from './pg-database.js';

/** Rounds of each race: enough to see both orders, few enough to stay fast. */
const rounds: number = 20;
/** Concurrent requests per race (the pool has 10 connections). */
const racers: number = 6;
/** Each race runs `rounds` times; a loaded machine with a slow disk needs more than the default 30 s. */
const raceTimeout: number = 180_000;

/**
 * Races of `createRevision` with an idempotency key on a real PostgreSQL, with several connections (see
 * `pg-database.ts`): the row lock of the document, and the primary key of the record.
 */
describe.skipIf(serverUrl === undefined)('Idempotency keys of versions on PostgreSQL', { timeout: raceTimeout }, () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let service: DocumentsService;

  beforeAll(async () => {
    database = await openTestDatabase('reviewr_revision_keys');
    ({ pool } = database);
    service = new DocumentsService(drizzle(pool, { schema }));
  }, setupTimeout);

  afterAll(async () => {
    if (database !== undefined) {
      await closeTestDatabase(database);
    }
  }, setupTimeout);

  const create = async (content: string): Promise<Document> => service.create({ title: 'Chapitre', content });

  /** Revisions of a document, oldest first. */
  const revisionsOf = async (id: string): Promise<{ revision: number; content: string }[]> =>
    (
      await pool.query<{ revision: number; content: string }>(
        'SELECT revision, content FROM revisions WHERE document_id = $1 ORDER BY revision',
        [id],
      )
    ).rows;

  it('the same request sent concurrently with its key creates one revision, answered to every request', async () => {
    for (let round: number = 0; round < rounds; round += 1) {
      const doc = await create('v1');
      await service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 });
      const input = { name: 'Relu', draftVersion: 2, baseRevision: 1, idempotencyKey: randomUUID() };
      const results = await Promise.all(
        Array.from({ length: racers }, async () => service.createRevision(doc.id, input)),
      );

      expect(results.map((r) => [r.revision, r.content, r.savedRevision])).toEqual(Array(racers).fill([2, 'v2', 2]));
      expect(await revisionsOf(doc.id)).toEqual([
        { revision: 1, content: 'v1' },
        { revision: 2, content: 'v2' },
      ]);
      const { rows } = await pool.query<{ revision: number }>(
        'SELECT revision FROM revision_requests WHERE idempotency_key = $1',
        [input.idempotencyKey],
      );
      expect(rows).toEqual([{ revision: 2 }]);
    }
  });

  it('one key sent concurrently on two documents: one version is saved, the other request refused', async () => {
    for (let round: number = 0; round < rounds; round += 1) {
      const docs: Document[] = await Promise.all([create('a1'), create('b1')]);
      for (const doc of docs) {
        await service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 });
      }
      const input = { draftVersion: 2, baseRevision: 1, idempotencyKey: randomUUID() };
      const results = await Promise.allSettled(
        docs.map(async (doc) => service.createRevision(doc.id, { ...input, name: null })),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused: unknown[] = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toBeInstanceOf(UnprocessableEntityException);
      const counts: number[] = await Promise.all(docs.map(async (doc) => (await revisionsOf(doc.id)).length));
      expect([...counts].sort()).toEqual([1, 2]);
    }
  });
});
