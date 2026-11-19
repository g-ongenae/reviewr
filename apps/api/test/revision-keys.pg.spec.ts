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

  /** Wait until `count` sessions of the test database are blocked on a lock. */
  const waitForBlocked = async (count: number): Promise<void> => {
    for (let attempt: number = 0; attempt < 200; attempt += 1) {
      const { rows } = await database.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [database.name],
      );
      if (rows[0]?.n === count) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} session(s) waiting on a lock`);
  };

  it('one key on two documents, both past their lookup: one version is saved, the other rolled back', async () => {
    for (let round: number = 0; round < 5; round += 1) {
      const docs: Document[] = await Promise.all([create('a1'), create('b1')]);
      for (const doc of docs) {
        await service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 });
      }
      const input = { name: null, draftVersion: 2, baseRevision: 1, idempotencyKey: randomUUID() };

      // SHARE lets the lookups (plain selects) through and stops the inserts into the table. Both requests blocked
      // there have looked the key up, missed it, and appended their revision: they meet at the insert conflict.
      const holder: pg.PoolClient = await pool.connect();
      let failure: Error | undefined;
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE revision_requests IN SHARE MODE');
        pending = Promise.allSettled(docs.map(async (doc) => service.createRevision(doc.id, input)));
        await waitForBlocked(2);
        await holder.query('COMMIT');
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        holder.release(failure);
        await pending?.catch(() => undefined);
      }
      const results: PromiseSettledResult<unknown>[] = await pending;

      const winners: number[] = results.flatMap((r, index) => (r.status === 'fulfilled' ? [index] : []));
      expect(winners).toHaveLength(1);
      const winner: Document = docs[winners[0] ?? 0] as Document;
      const loser: Document = docs[1 - (winners[0] ?? 0)] as Document;
      const refused = results.find((r) => r.status === 'rejected');
      expect(refused?.reason).toBeInstanceOf(UnprocessableEntityException);

      expect(await revisionsOf(winner.id)).toEqual([
        { revision: 1, content: winner.content },
        { revision: 2, content: 'v2' },
      ]);
      // The loser's revision, head and draft were rolled back with the refused insert.
      expect(await revisionsOf(loser.id)).toEqual([{ revision: 1, content: loser.content }]);
      expect(await service.get(loser.id)).toMatchObject({
        revision: 1,
        content: loser.content,
        draft: { content: 'v2', draftVersion: 2, baseRevision: 1 },
      });
      const { rows } = await pool.query<{ documentId: string; revision: number }>(
        'SELECT document_id AS "documentId", revision FROM revision_requests WHERE idempotency_key = $1',
        [input.idempotencyKey],
      );
      expect(rows).toEqual([{ documentId: winner.id, revision: 2 }]);
    }
  });
});
