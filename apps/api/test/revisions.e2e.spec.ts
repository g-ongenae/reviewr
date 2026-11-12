/* eslint-disable no-null/no-null -- the API sends null for an unnamed version and an untitled document */
import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  clientFeaturesHeader,
  type Document,
  type DraftConflictBody,
  type Revision,
  type RevisionSummary,
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
    method: 'GET' | 'POST' | 'PUT',
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
      { draftVersion: 2, baseRevision: 0 },
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
});
