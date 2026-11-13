/* eslint-disable no-null/no-null -- an unnamed version is sent as null, as the API does */
import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import type { ConflictBody, Document, DocumentDraft } from '@reviewr/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import * as schema from '../src/database/schema.js';
import { DocumentsService } from '../src/documents/documents.service.js';

/**
 * Row-lock tests of `saveDraft`, `update` and `createRevision` on a real PostgreSQL, with several
 * connections (the e2e tests run on PGlite, which runs one transaction at a time).
 *
 * `TEST_DATABASE_URL` points at a server where the user may create databases; the file creates its own
 * database, migrates it and drops it at the end. Without the variable the file is skipped, unless
 * `REQUIRE_TEST_DATABASE` is set (the CI), where a missing variable is an error.
 */
const serverUrl: string | undefined = process.env.TEST_DATABASE_URL;
if (serverUrl === undefined && process.env.REQUIRE_TEST_DATABASE !== undefined) {
  throw new Error('REQUIRE_TEST_DATABASE is set but TEST_DATABASE_URL is not: the PostgreSQL tests would be skipped');
}

/** Rounds of each race: enough to see both orders, few enough to stay fast. */
const rounds: number = 20;
/** Concurrent requests per race (the pool has 10 connections). */
const racers: number = 6;
/** Each race runs `rounds` times; a loaded machine with a slow disk needs more than the default 30 s. */
const raceTimeout: number = 180_000;
/** Creating and migrating the database, or waiting for its sessions to close, on the same kind of machine. */
const setupTimeout: number = 120_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; conflict: ConflictBody };

/** Settle a service call, turning a 409 into its body. Any other error fails the test. */
const settle = async <T>(call: Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await call };
  } catch (error) {
    if (error instanceof ConflictException) {
      return { ok: false, conflict: error.getResponse() as ConflictBody };
    }
    throw error;
  }
};

describe.skipIf(serverUrl === undefined)('Document row lock on PostgreSQL', () => {
  const databaseName: string = `reviewr_concurrency_${process.pid}_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let service: DocumentsService;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url: URL = new URL(serverUrl ?? '');
    url.pathname = `/${databaseName}`;
    await runMigrations(url.toString());
    pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    service = new DocumentsService(drizzle(pool, { schema }));
  }, setupTimeout);

  afterAll(async () => {
    await pool?.end();
    if (admin === undefined) {
      return;
    }
    // `pool.end()` resolves before the server has closed every session. Dropping the database by force at that
    // moment terminates them, and the clients, already detached from the pool, report it as unhandled errors
    // that fail the run. So wait until the sessions are gone, then drop without force: if one is still there
    // after 10 s, the drop fails and names the database, which is left for a manual cleanup.
    for (let attempt: number = 0; attempt < 400; attempt += 1) {
      const { rows } = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [databaseName],
      );
      if (rows[0]?.n === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }, setupTimeout);

  /** Wait until `count` sessions of the test database are blocked on a lock. */
  const waitForBlocked = async (count: number): Promise<void> => {
    for (let attempt: number = 0; attempt < 200; attempt += 1) {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [databaseName],
      );
      if (rows[0]?.n === count) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} session(s) waiting on a lock`);
  };

  /** Run `call` while another connection holds the document row; `change` runs in that transaction. */
  const whileLocked = async <T>(
    id: string,
    call: () => Promise<T>,
    change: (holder: pg.PoolClient) => Promise<unknown>,
  ): Promise<Outcome<T>> => {
    // A connection of its own: the service's transaction takes another one from the pool.
    const holder: pg.PoolClient = await pool.connect();
    // On failure the holder may still be in its transaction: destroy the connection rather than return it to
    // the pool, which rolls back, lets the waiting call finish and keeps the lock out of the next test.
    let failure: Error | undefined;
    let pending: Promise<Outcome<T>> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [id]);
      let settled: boolean = false;
      pending = settle(call()).finally(() => {
        settled = true;
      });
      await waitForBlocked(1);
      expect(settled).toBe(false);
      await change(holder);
      await holder.query('COMMIT');

      const outcome: Outcome<T> = await pending;

      return outcome;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      holder.release(failure);
      if (failure !== undefined) {
        // Let the call that was waiting finish before the next test, and keep a late rejection from it out of
        // the run's unhandled errors: the failure reported is the one above.
        await pending?.catch(() => undefined);
      }
    }
  };

  const create = async (content: string): Promise<Document> => service.create({ title: 'Chapitre', content });

  /** Revisions of a document, oldest first. */
  const revisionsOf = async (id: string): Promise<{ revision: number; content: string }[]> =>
    (
      await pool.query<{ revision: number; content: string }>(
        'SELECT revision, content FROM revisions WHERE document_id = $1 ORDER BY revision',
        [id],
      )
    ).rows;

  /**
   * Check what must hold after any race: revisions are numbered 1..n without gaps or duplicates and the
   * head is the last one; every text the server acknowledged is the draft or a revision; no counter
   * answered to a client is ahead of the stored one (they never go backwards).
   */
  const checkInvariants = async (
    id: string,
    acknowledged: string[],
    answered: { revision: number; draftVersion: number }[],
  ): Promise<void> => {
    const document: Document = await service.get(id);
    const history = await revisionsOf(id);
    expect(history.map((r) => r.revision)).toEqual(history.map((_, index) => index + 1));
    expect(document.revision).toBe(history.length);
    expect(document.content).toBe(history.at(-1)?.content);
    const kept: Set<string> = new Set([document.draft?.content ?? '', ...history.map((r) => r.content)]);
    for (const text of acknowledged) {
      expect(kept).toContain(text);
    }
    for (const counters of answered) {
      expect(counters.revision).toBeLessThanOrEqual(document.revision);
      expect(counters.draftVersion).toBeLessThanOrEqual(document.draft?.draftVersion ?? 0);
    }
  };

  describe('a request waits for the row and decides on the committed state', () => {
    it('saveDraft answers draft_conflict when the draft moved while it waited', async () => {
      const doc = await create('v1');
      const result = await whileLocked(
        doc.id,
        async () => service.saveDraft(doc.id, { content: 'mine', draftVersion: 1 }),
        async (holder) =>
          holder.query(`UPDATE documents SET draft_content = 'theirs', draft_version = 2 WHERE id = $1`, [doc.id]),
      );

      expect(result).toMatchObject({ ok: false, conflict: { code: 'draft_conflict', draft: { content: 'theirs' } } });
      expect((await service.get(doc.id)).draft).toMatchObject({ content: 'theirs', draftVersion: 2 });
    });

    it('update keeps a draft autosaved while it waited as a revision, then answers stale_revision', async () => {
      const doc = await create('v1');
      const result = await whileLocked(
        doc.id,
        async () => service.update(doc.id, { title: 'Chapitre', content: 'mine', baseRevision: 1 }),
        async (holder) =>
          holder.query(`UPDATE documents SET draft_content = 'autosaved', draft_version = 2 WHERE id = $1`, [doc.id]),
      );

      expect(result).toMatchObject({ ok: false, conflict: { code: 'stale_revision', revision: 2 } });
      expect(await revisionsOf(doc.id)).toEqual([
        { revision: 1, content: 'v1' },
        { revision: 2, content: 'autosaved' },
      ]);
    });

    it('update answers stale_revision when a revision was created while it waited', async () => {
      const doc = await create('v1');
      const result = await whileLocked(
        doc.id,
        async () => service.update(doc.id, { title: 'Chapitre', content: 'mine', baseRevision: 1 }),
        async (holder) => {
          await holder.query(
            `UPDATE documents SET content = 'theirs', revision = 2, draft_content = 'theirs', draft_version = 2,
               draft_base_revision = 2 WHERE id = $1`,
            [doc.id],
          );
          await holder.query(`INSERT INTO revisions (document_id, revision, content) VALUES ($1, 2, 'theirs')`, [
            doc.id,
          ]);
        },
      );

      expect(result).toMatchObject({ ok: false, conflict: { code: 'stale_revision', revision: 2 } });
      expect((await revisionsOf(doc.id)).map((r) => r.content)).toEqual(['v1', 'theirs']);
    });

    it('createRevision answers draft_conflict when the draft moved while it waited', async () => {
      const doc = await create('v1');
      await service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 });
      const result = await whileLocked(
        doc.id,
        async () => service.createRevision(doc.id, { name: null, draftVersion: 2, baseRevision: 1 }),
        async (holder) =>
          holder.query(`UPDATE documents SET draft_content = 'v3', draft_version = 3 WHERE id = $1`, [doc.id]),
      );

      expect(result).toMatchObject({ ok: false, conflict: { code: 'draft_conflict', draft: { content: 'v3' } } });
      expect(await revisionsOf(doc.id)).toHaveLength(1);
    });

    it('createRevision is a no-op when the draft became the head while it waited', async () => {
      const doc = await create('v1');
      await service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 });
      const result = await whileLocked(
        doc.id,
        async () => service.createRevision(doc.id, { name: 'retry', draftVersion: 2, baseRevision: 1 }),
        async (holder) => {
          await holder.query(
            `UPDATE documents SET content = 'v2', revision = 2, draft_base_revision = 2 WHERE id = $1`,
            [doc.id],
          );
          await holder.query(`INSERT INTO revisions (document_id, revision, content) VALUES ($1, 2, 'v2')`, [doc.id]);
        },
      );

      expect(result).toMatchObject({ ok: true, value: { revision: 2, content: 'v2' } });
      expect(await revisionsOf(doc.id)).toHaveLength(2);
    });
  });

  describe('races', { timeout: raceTimeout }, () => {
    it('concurrent saveDraft on the same draftVersion: exactly one wins', async () => {
      for (let round: number = 0; round < rounds; round += 1) {
        const doc = await create('v1');
        const results = await Promise.all(
          Array.from({ length: racers }, async (_, index) =>
            settle(service.saveDraft(doc.id, { content: `text ${index}`, draftVersion: 1 })),
          ),
        );
        const winners: DocumentDraft[] = results.flatMap((r) => (r.ok ? [r.value] : []));

        expect(winners).toHaveLength(1);
        expect(results.filter((r) => !r.ok).map((r) => (r.ok ? undefined : r.conflict.code))).toEqual(
          Array(racers - 1).fill('draft_conflict'),
        );
        expect((await service.get(doc.id)).draft).toMatchObject({ content: winners[0]?.content, draftVersion: 2 });
        await checkInvariants(
          doc.id,
          winners.map((w) => w.content),
          winners.map((w) => ({ revision: 1, draftVersion: w.draftVersion })),
        );
      }
    });

    // An idempotency test, not a lock test: without the lock the calls would write the same row and give the
    // same answers. The lock of saveDraft is covered by the race above and by the deterministic test.
    it('the same saveDraft sent concurrently is saved once and answered as saved every time', async () => {
      for (let round: number = 0; round < rounds; round += 1) {
        const doc = await create('v1');
        const results = await Promise.all(
          Array.from({ length: racers }, async () => service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 })),
        );

        expect(results).toEqual(Array(racers).fill({ content: 'v2', draftVersion: 2, baseRevision: 1 }));
        expect((await service.get(doc.id)).draft).toEqual({ content: 'v2', draftVersion: 2, baseRevision: 1 });
        await checkInvariants(
          doc.id,
          ['v2'],
          results.map((r) => ({ revision: 1, draftVersion: r.draftVersion })),
        );
      }
    });

    it('concurrent createRevision create one revision only', async () => {
      for (let round: number = 0; round < rounds; round += 1) {
        const doc = await create('v1');
        await service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 });
        const results = await Promise.all(
          Array.from({ length: racers }, async (_, index) =>
            service.createRevision(doc.id, { name: `name ${index}`, draftVersion: 2, baseRevision: 1 }),
          ),
        );

        expect(results.map((r) => [r.revision, r.content])).toEqual(Array(racers).fill([2, 'v2']));
        expect(await revisionsOf(doc.id)).toEqual([
          { revision: 1, content: 'v1' },
          { revision: 2, content: 'v2' },
        ]);
        await checkInvariants(
          doc.id,
          ['v2'],
          results.map((r) => ({ revision: r.revision, draftVersion: r.draft?.draftVersion ?? 0 })),
        );
      }
    });

    it('saveDraft racing createRevision loses no text', async () => {
      const orders: Set<string> = new Set();
      for (let round: number = 0; round < rounds; round += 1) {
        const doc = await create('v1');
        await service.saveDraft(doc.id, { content: 'v2', draftVersion: 1 });
        const [version, draft] = await Promise.all([
          settle(service.createRevision(doc.id, { name: null, draftVersion: 2, baseRevision: 1 })),
          settle(service.saveDraft(doc.id, { content: 'v3', draftVersion: 2 })),
        ]);

        // Either the version was created first and the draft saved on top of it, or the draft moved first
        // and the version was refused: never both refused, never both created on the same draft.
        if (version.ok) {
          expect(version.value).toMatchObject({ revision: 2, content: 'v2' });
          expect(draft).toMatchObject({ ok: true, value: { content: 'v3', draftVersion: 3, baseRevision: 2 } });
        } else {
          expect(version.conflict).toMatchObject({ code: 'draft_conflict', draft: { content: 'v3' } });
          expect(draft).toMatchObject({ ok: true, value: { content: 'v3', draftVersion: 3, baseRevision: 1 } });
        }
        orders.add(version.ok ? 'version first' : 'draft first');
        await checkInvariants(
          doc.id,
          [...(version.ok ? ['v2'] : []), ...(draft.ok ? [draft.value.content] : [])],
          [
            ...(version.ok ? [{ revision: 2, draftVersion: version.value.draft?.draftVersion ?? 0 }] : []),
            ...(draft.ok ? [{ revision: draft.value.baseRevision ?? 0, draftVersion: draft.value.draftVersion }] : []),
          ],
        );
      }
      // eslint-disable-next-line no-console -- shows in the CI log that both orders were exercised
      console.info(`saveDraft vs createRevision orders seen: ${[...orders].join(', ')}`);
    });

    it('the old update racing saveDraft loses no text', async () => {
      const orders: Set<string> = new Set();
      for (let round: number = 0; round < rounds; round += 1) {
        const doc = await create('v1');
        const [saved, draft] = await Promise.all([
          settle(service.update(doc.id, { title: 'Chapitre', content: 'saved', baseRevision: 1 })),
          settle(service.saveDraft(doc.id, { content: 'typed', draftVersion: 1 })),
        ]);

        if (saved.ok) {
          // The update came first: the autosave based on the old draft is refused.
          expect(saved.value).toMatchObject({ revision: 2, content: 'saved' });
          expect(draft).toMatchObject({ ok: false, conflict: { code: 'draft_conflict' } });
        } else {
          // The autosave came first: the update keeps it as a revision before refusing.
          expect(draft).toMatchObject({ ok: true, value: { content: 'typed', draftVersion: 2 } });
          expect(saved.conflict).toMatchObject({ code: 'stale_revision', revision: 2 });
          expect((await revisionsOf(doc.id)).at(-1)?.content).toBe('typed');
        }
        orders.add(saved.ok ? 'update first' : 'draft first');
        await checkInvariants(
          doc.id,
          [...(saved.ok ? [saved.value.content] : []), ...(draft.ok ? [draft.value.content] : [])],
          [
            ...(saved.ok
              ? [{ revision: saved.value.revision, draftVersion: saved.value.draft?.draftVersion ?? 0 }]
              : []),
            ...(draft.ok ? [{ revision: 1, draftVersion: draft.value.draftVersion }] : []),
          ],
        );
      }
      // eslint-disable-next-line no-console -- shows in the CI log that both orders were exercised
      console.info(`update vs saveDraft orders seen: ${[...orders].join(', ')}`);
    });
  });
});
