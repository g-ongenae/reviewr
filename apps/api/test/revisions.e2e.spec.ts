/* eslint-disable no-null/no-null -- the API sends null for an unnamed version and an untitled document */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  clientFeaturesHeader,
  type Document,
  type DraftConflictBody,
  type Revision,
  type RevisionSummary,
  type SavedVersion,
  type StaleRevisionBody,
} from '@reviewr/shared';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

const unknownId: string = '00000000-0000-4000-8000-000000000000';
const currentClient = { [clientFeaturesHeader]: 'nullable-title' };

/**
 * End-to-end tests of `POST /documents/:id/revisions` (save the draft as a version).
 */
describe('Revisions API', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;

  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = currentClient,
  ) => {
    const response = await app.inject({ method, url, payload, headers });

    return { status: response.statusCode, body: response.body.length > 0 ? (response.json() as unknown) : undefined };
  };

  const create = async (content: string, title: string | null = 'Chapitre'): Promise<Document> =>
    (await call('POST', '/documents', { title, content })).body as Document;

  const saveDraft = async (id: string, content: string, draftVersion: number) =>
    call('PUT', `/documents/${id}/draft`, { content, draftVersion });

  const saveVersion = async (id: string, payload: object, headers?: Record<string, string>) =>
    call('POST', `/documents/${id}/revisions`, payload, headers);

  const get = async (id: string): Promise<Document> => (await call('GET', `/documents/${id}`)).body as Document;

  const listRevisions = async (id: string): Promise<RevisionSummary[]> =>
    (await call('GET', `/documents/${id}/revisions`)).body as RevisionSummary[];

  beforeAll(async () => {
    pglite = new PGlite();
    const db: PgliteDatabase<typeof schema> = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(databaseToken)
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app, { corsOrigin: true });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it('creates a revision with the draft text, the title and the name', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);

    const { status, body } = await saveVersion(doc.id, { name: '  Relu  ', draftVersion: 2, baseRevision: 1 });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: doc.id,
      title: 'Chapitre',
      revision: 2,
      content: 'v2',
      draft: { content: 'v2', draftVersion: 2, baseRevision: 2 },
    });
    expect(await get(doc.id)).toEqual(body);

    const revision = (await call('GET', `/documents/${doc.id}/revisions/2`)).body as Revision;
    expect(revision).toMatchObject({ revision: 2, title: 'Chapitre', name: 'Relu', content: 'v2' });
  });

  it('lists the names of the revisions, null when unnamed', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    await saveVersion(doc.id, { name: 'Premier jet', draftVersion: 2, baseRevision: 1 });
    await saveDraft(doc.id, 'v3', 2);
    await saveVersion(doc.id, { name: '   ', draftVersion: 3, baseRevision: 2 });
    await saveDraft(doc.id, 'v4', 3);
    await saveVersion(doc.id, { draftVersion: 4, baseRevision: 3 });

    expect((await listRevisions(doc.id)).map(({ revision, name }) => ({ revision, name }))).toEqual([
      { revision: 4, name: null },
      { revision: 3, name: null },
      { revision: 2, name: 'Premier jet' },
      { revision: 1, name: null },
    ]);
  });

  it('is a no-op when the draft already is the head, and ignores the name then', async () => {
    const doc = await create('v1');
    const before = await get(doc.id);

    expect(await saveVersion(doc.id, { name: 'Rien', draftVersion: 1, baseRevision: 1 })).toEqual({
      status: 200,
      body: before,
    });
    expect(await get(doc.id)).toEqual(before);
    expect(await listRevisions(doc.id)).toEqual([expect.objectContaining({ revision: 1, name: null })]);
  });

  it('creates one revision only when the same request is retried after a lost response', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    const request = { name: 'Relu', draftVersion: 2, baseRevision: 1 };

    const first = await saveVersion(doc.id, request);
    const retry = await saveVersion(doc.id, request);
    expect(first.status).toBe(200);
    expect(retry).toEqual(first);
    expect((await listRevisions(doc.id)).map((rev) => rev.revision)).toEqual([2, 1]);
  });

  it('keeps the first name when the same draft is saved twice under two names', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);

    const first = await saveVersion(doc.id, { name: 'Premier', draftVersion: 2, baseRevision: 1 });
    const second = await saveVersion(doc.id, { name: 'Second', draftVersion: 2, baseRevision: 1 });
    expect(first.status).toBe(200);
    // 200 says the draft text is the head, not that this call created the revision or applied its name.
    expect(second).toEqual(first);
    expect((await listRevisions(doc.id)).map(({ revision, name }) => ({ revision, name }))).toEqual([
      { revision: 2, name: 'Premier' },
      { revision: 1, name: null },
    ]);
  });

  it('is a no-op after the old PUT kept the draft as a revision, which stays unnamed', async () => {
    const doc = await create('A');
    await saveDraft(doc.id, 'B', 1);

    // A build that only knows revisions saves C on revision 1: the server keeps B as revision 2, then refuses.
    const put = await call('PUT', `/documents/${doc.id}`, { title: 'Chapitre', content: 'C', baseRevision: 1 });
    expect(put).toMatchObject({ status: 409, body: { code: 'stale_revision', revision: 2 } });

    const { status, body } = await saveVersion(doc.id, { name: 'Relu', draftVersion: 2, baseRevision: 1 });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      revision: 2,
      content: 'B',
      draft: { content: 'B', draftVersion: 2, baseRevision: 2 },
    });
    expect((await listRevisions(doc.id)).map(({ revision, name }) => ({ revision, name }))).toEqual([
      { revision: 2, name: null },
      { revision: 1, name: null },
    ]);
  });

  it('answers 409 draft_conflict to a retry sent after the draft was saved again, with the version kept', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    const request = { name: null, draftVersion: 2, baseRevision: 1 };
    expect((await saveVersion(doc.id, request)).status).toBe(200);
    await saveDraft(doc.id, 'v3', 2);

    const retry = await saveVersion(doc.id, request);
    expect(retry).toMatchObject({
      status: 409,
      body: { code: 'draft_conflict', draft: { content: 'v3', draftVersion: 3, baseRevision: 2 } },
    });
    expect((await listRevisions(doc.id)).map((rev) => rev.revision)).toEqual([2, 1]);
    const kept = (await call('GET', `/documents/${doc.id}/revisions/2`)).body as Revision;
    expect(kept).toMatchObject({ content: 'v2', name: null });
  });

  it('answers 409 draft_conflict with the server draft when the draft moved, and creates nothing', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'phone', 1);

    const { status, body } = await saveVersion(doc.id, { draftVersion: 1, baseRevision: 1 });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'draft_conflict',
      draft: { content: 'phone', draftVersion: 2, baseRevision: 1 },
    } satisfies Omit<DraftConflictBody, 'message'>);
    expect((body as DraftConflictBody).message).toEqual(expect.any(String));
    expect((await get(doc.id)).revision).toBe(1);

    // Even when the server draft is the head, a stale draftVersion is not reported as saved.
    const other = await create('v1');
    await saveDraft(other.id, 'v2', 1);
    await saveDraft(other.id, 'v1', 2);
    expect((await saveVersion(other.id, { draftVersion: 2, baseRevision: 1 })).status).toBe(409);
  });

  it('answers 409 stale_revision with the current revision when the head moved', async () => {
    const doc = await create('v1');
    await call('PUT', `/documents/${doc.id}`, { title: 'Chapitre', content: 'v2', baseRevision: 1 });
    const moved = await get(doc.id);
    await saveDraft(doc.id, 'v3', moved.draft?.draftVersion ?? 0);

    const { status, body } = await saveVersion(doc.id, { draftVersion: 3, baseRevision: 1 });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'stale_revision',
      revision: 2,
    } satisfies Omit<StaleRevisionBody, 'message'>);
    expect((await get(doc.id)).revision).toBe(2);
  });

  it('answers 404 for an unknown document and 400 for a malformed id', async () => {
    expect((await saveVersion(unknownId, { draftVersion: 1, baseRevision: 1 })).status).toBe(404);
    expect((await call('POST', '/documents/not-a-uuid/revisions', { draftVersion: 1, baseRevision: 1 })).status).toBe(
      400,
    );
  });

  it('validates the payload', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    const invalid: object[] = [
      { baseRevision: 1 },
      { draftVersion: 2 },
      { draftVersion: 0, baseRevision: 1 },
      { draftVersion: 2, baseRevision: -1 },
      { draftVersion: 2, baseRevision: 0.5 },
      { draftVersion: 1.5, baseRevision: 1 },
      { draftVersion: '2', baseRevision: 1 },
      { draftVersion: 2, baseRevision: 1, name: 42 },
      { draftVersion: 2, baseRevision: 1, name: 'x'.repeat(201) },
      { draftVersion: 2, baseRevision: 1, extra: true },
    ];
    for (const payload of invalid) {
      expect((await saveVersion(doc.id, payload)).status, JSON.stringify(payload)).toBe(400);
    }
    expect((await get(doc.id)).revision).toBe(1);

    // The limit applies to the trimmed name.
    expect((await saveVersion(doc.id, { draftVersion: 2, baseRevision: 1, name: ` ${'x'.repeat(200)} ` })).status).toBe(
      200,
    );
  });

  it("keeps title: '' for an untitled document when the client does not announce nullable-title", async () => {
    const doc = await create('v1', null);
    await saveDraft(doc.id, 'v2', 1);

    const legacy = await saveVersion(doc.id, { draftVersion: 2, baseRevision: 1 }, {});
    expect(legacy).toMatchObject({ status: 200, body: { title: '', revision: 2 } });
    expect((await get(doc.id)).title).toBeNull();
  });

  it('leaves the old PUT /documents/:id working after a version was saved', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    await saveVersion(doc.id, { draftVersion: 2, baseRevision: 1 });

    const { status, body } = await call('PUT', `/documents/${doc.id}`, {
      title: 'Chapitre',
      content: 'v3',
      baseRevision: 2,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ revision: 3, content: 'v3', draft: { content: 'v3', baseRevision: 3 } });
  });
  describe('with an idempotency key', () => {
    /** Revisions of a document, newest first, as `[revision, name]`. */
    const history = async (id: string): Promise<[number, string | null][]> =>
      (await listRevisions(id)).map(({ revision, name }) => [revision, name]);

    it('answers no savedRevision without a key, as before', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'v2', 1);

      const { status, body } = await saveVersion(doc.id, { draftVersion: 2, baseRevision: 1 });
      expect(status).toBe(200);
      expect(body).not.toHaveProperty('savedRevision');
    });

    it('answers the revision created, and the same request sent again creates nothing', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'v2', 1);
      const request = { name: 'Relu', draftVersion: 2, baseRevision: 1, idempotencyKey: randomUUID() };

      const first = await saveVersion(doc.id, request);
      expect(first).toMatchObject({ status: 200, body: { revision: 2, content: 'v2', savedRevision: 2 } });
      expect(await saveVersion(doc.id, request)).toEqual(first);
      expect(await history(doc.id)).toEqual([
        [2, 'Relu'],
        [1, null],
      ]);
    });

    it('answers the same request sent again with its revision after text was typed, versions saved and a rename', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'v2', 1);
      const request = { name: 'Relu', draftVersion: 2, baseRevision: 1, idempotencyKey: randomUUID() };
      expect((await saveVersion(doc.id, request)).status).toBe(200);

      // The answer was lost; meanwhile the writer types, saves another version, renames, and types again.
      await saveDraft(doc.id, 'v3', 2);
      expect((await saveVersion(doc.id, { draftVersion: 3, baseRevision: 2 })).status).toBe(200);
      expect((await call('PATCH', `/documents/${doc.id}`, { title: 'Renommé' })).status).toBe(200);
      await saveDraft(doc.id, 'v4', 3);
      const now = await get(doc.id);

      const retry = await saveVersion(doc.id, request);
      expect(retry).toEqual({ status: 200, body: { ...now, savedRevision: 2 } satisfies SavedVersion });
      expect(await history(doc.id)).toEqual([
        [3, null],
        [2, 'Relu'],
        [1, null],
      ]);
      expect((await call('GET', `/documents/${doc.id}/revisions/2`)).body).toMatchObject({ content: 'v2' });
    });

    it('treats a null base and a base of 0 as the same request', async () => {
      const id: string = randomUUID();
      await call('POST', '/documents', { id, title: null, content: 'premier jet', draftOnly: true });
      const idempotencyKey: string = randomUUID();

      const first = await saveVersion(id, { draftVersion: 1, baseRevision: null, idempotencyKey });
      expect(first).toMatchObject({ status: 200, body: { revision: 1, savedRevision: 1 } });
      await saveDraft(id, 'suite', 1);
      expect(await saveVersion(id, { draftVersion: 1, baseRevision: 0, idempotencyKey })).toMatchObject({
        status: 200,
        body: { revision: 1, savedRevision: 1, draft: { content: 'suite' } },
      });
    });

    it('refuses the key with another request with 422, and creates nothing', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'v2', 1);
      const idempotencyKey: string = randomUUID();
      expect(
        (await saveVersion(doc.id, { name: 'Relu', draftVersion: 2, baseRevision: 1, idempotencyKey })).status,
      ).toBe(200);
      await saveDraft(doc.id, 'v3', 2);
      const other = await create('autre');
      await saveDraft(other.id, 'autre 2', 1);

      const reuses: [string, object][] = [
        [doc.id, { name: 'Autre nom', draftVersion: 2, baseRevision: 1 }],
        [doc.id, { name: 'Relu', draftVersion: 3, baseRevision: 2 }],
        [doc.id, { name: 'Relu', draftVersion: 2, baseRevision: 0 }],
        [other.id, { name: 'Relu', draftVersion: 2, baseRevision: 1 }],
      ];
      for (const [id, request] of reuses) {
        const { status } = await saveVersion(id, { ...request, idempotencyKey });
        expect(status, JSON.stringify(request)).toBe(422);
      }
      expect(await history(doc.id)).toEqual([
        [2, 'Relu'],
        [1, null],
      ]);
      expect(await history(other.id)).toEqual([[1, null]]);
    });

    it('records the head when the draft already is the head, so the request sent again still answers it', async () => {
      const doc = await create('v1');
      const request = { name: 'Rien', draftVersion: 1, baseRevision: 1, idempotencyKey: randomUUID() };

      expect(await saveVersion(doc.id, request)).toMatchObject({
        status: 200,
        body: { revision: 1, savedRevision: 1 },
      });
      await saveDraft(doc.id, 'v2', 1);
      expect(await saveVersion(doc.id, request)).toMatchObject({
        status: 200,
        body: { revision: 1, savedRevision: 1, draft: { content: 'v2', draftVersion: 2 } },
      });
      // The name of a no-op is ignored, as without a key.
      expect(await history(doc.id)).toEqual([[1, null]]);
    });

    it('answers savedRevision null for an empty draft without revision, and records nothing', async () => {
      const id: string = randomUUID();
      await call('POST', '/documents', { id, title: null, content: '', draftOnly: true });
      const request = { draftVersion: 1, baseRevision: null, idempotencyKey: randomUUID() };

      expect(await saveVersion(id, request)).toMatchObject({ status: 200, body: { revision: 0, savedRevision: null } });
      // Nothing was saved, so nothing can be answered as saved once the draft moved.
      await saveDraft(id, 'premier mot', 1);
      expect(await saveVersion(id, request)).toMatchObject({ status: 409, body: { code: 'draft_conflict' } });
      expect(await listRevisions(id)).toEqual([]);
    });

    it('records nothing for a request refused with 409: the same request sent again is decided again', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'phone', 1);
      const stale = { draftVersion: 1, baseRevision: 1, idempotencyKey: randomUUID() };
      expect(await saveVersion(doc.id, stale)).toMatchObject({ status: 409, body: { code: 'draft_conflict' } });
      expect(await saveVersion(doc.id, stale)).toMatchObject({ status: 409, body: { code: 'draft_conflict' } });

      // Head moved under a draft that is not the head: stale_revision, again and again.
      await call('PUT', `/documents/${doc.id}`, { title: 'Chapitre', content: 'laptop', baseRevision: 1 });
      const moved = await get(doc.id);
      await saveDraft(doc.id, 'laptop 2', moved.draft?.draftVersion ?? 0);
      const behind = {
        draftVersion: (moved.draft?.draftVersion ?? 0) + 1,
        baseRevision: 1,
        idempotencyKey: randomUUID(),
      };
      expect(await saveVersion(doc.id, behind)).toMatchObject({ status: 409, body: { code: 'stale_revision' } });
      expect(await saveVersion(doc.id, behind)).toMatchObject({ status: 409, body: { code: 'stale_revision' } });

      const revisions: number[] = (await listRevisions(doc.id)).map((rev) => rev.revision);
      expect(revisions).toEqual([...revisions].sort((a, b) => b - a));
      expect((await get(doc.id)).draft?.content).toBe('laptop 2');
      // The refused key was not taken: another request may still use it.
      expect(
        await saveVersion(doc.id, {
          draftVersion: behind.draftVersion,
          baseRevision: moved.revision,
          idempotencyKey: behind.idempotencyKey,
        }),
      ).toMatchObject({ status: 200, body: { content: 'laptop 2' } });
    });

    it('answers 404 to the same request once the document is deleted', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'v2', 1);
      const request = { draftVersion: 2, baseRevision: 1, idempotencyKey: randomUUID() };
      expect((await saveVersion(doc.id, request)).status).toBe(200);
      expect((await call('DELETE', `/documents/${doc.id}`)).status).toBe(204);

      expect((await saveVersion(doc.id, request)).status).toBe(404);
    });

    it('validates the key', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'v2', 1);
      for (const idempotencyKey of [null, '', 'not-a-uuid', 42]) {
        const { status } = await saveVersion(doc.id, { draftVersion: 2, baseRevision: 1, idempotencyKey });
        expect(status, JSON.stringify(idempotencyKey)).toBe(400);
      }
      expect((await get(doc.id)).revision).toBe(1);
    });
  });
});
