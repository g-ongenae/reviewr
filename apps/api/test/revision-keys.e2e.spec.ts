/* eslint-disable no-null/no-null -- the API sends null for an unnamed version and an untitled document */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { clientFeaturesHeader, type Document, type RevisionSummary, type SavedVersion } from '@reviewr/shared';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

const currentClient = { [clientFeaturesHeader]: 'nullable-title' };

/**
 * End-to-end tests of `POST /documents/:id/revisions` with an `idempotencyKey`: a version sent again safely.
 */
describe('Revisions API with an idempotency key', () => {
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
    expect((await saveVersion(doc.id, { name: 'Relu', draftVersion: 2, baseRevision: 1, idempotencyKey })).status).toBe(
      200,
    );
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

    // The old PUT kept the draft "phone" as revision 2; neither refused request added one.
    expect((await listRevisions(doc.id)).map((rev) => rev.revision)).toEqual([2, 1]);
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

  it('answers a request refused as stale as a no-op once another save made the same draft the head', async () => {
    const doc = await create('v1');
    await call('PUT', `/documents/${doc.id}`, { title: 'Chapitre', content: 'v2', baseRevision: 1 });
    await saveDraft(doc.id, 'v3', 2);
    const request = { name: 'Le mien', draftVersion: 3, baseRevision: 1, idempotencyKey: randomUUID() };
    expect(await saveVersion(doc.id, request)).toMatchObject({ status: 409, body: { code: 'stale_revision' } });

    // Another device saves the same draft as a version, on the current head; the draft keeps its version.
    expect(await saveVersion(doc.id, { name: 'Le leur', draftVersion: 3, baseRevision: 2 })).toMatchObject({
      status: 200,
      body: { revision: 3, draft: { draftVersion: 3 } },
    });

    expect(await saveVersion(doc.id, request)).toMatchObject({
      status: 200,
      body: { revision: 3, content: 'v3', savedRevision: 3 },
    });
    expect((await call('GET', `/documents/${doc.id}/revisions/3`)).body).toMatchObject({
      content: 'v3',
      name: 'Le leur',
    });
    expect(await history(doc.id)).toHaveLength(3);
  });

  it('finds the same document and the same key whatever the letter case of their UUIDs', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    const idempotencyKey: string = randomUUID();
    const request = { name: 'Relu', draftVersion: 2, baseRevision: 1 };

    const first = await saveVersion(doc.id.toUpperCase(), { ...request, idempotencyKey });
    expect(first).toMatchObject({ status: 200, body: { id: doc.id, savedRevision: 2 } });
    await saveDraft(doc.id, 'v3', 2);

    // The request hash uses the document's stored id, and the key is a uuid column: both compare canonically.
    for (const [id, key] of [
      [doc.id, idempotencyKey],
      [doc.id.toUpperCase(), idempotencyKey.toUpperCase()],
      [doc.id, idempotencyKey.toUpperCase()],
    ] as const) {
      expect(await saveVersion(id, { ...request, idempotencyKey: key })).toMatchObject({
        status: 200,
        body: { revision: 2, savedRevision: 2, draft: { content: 'v3' } },
      });
    }
    expect(await history(doc.id)).toEqual([
      [2, 'Relu'],
      [1, null],
    ]);
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
