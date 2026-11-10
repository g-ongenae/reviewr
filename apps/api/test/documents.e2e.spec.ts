import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Document, DocumentSummary, Revision, RevisionSummary } from '@reviewr/shared';
import { eq } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

/**
 * End-to-end tests of the REST API against an in-process PostgreSQL (PGlite).
 */
describe('Documents API', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;
  let db: PgliteDatabase<typeof schema>;

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => {
    const response = await app.inject({ method, url, payload });

    return { status: response.statusCode, body: response.body.length > 0 ? (response.json() as unknown) : undefined };
  };

  const create = async (title: string, content: string): Promise<Document> =>
    (await call('POST', '/documents', { title, content })).body as Document;

  const draftOf = async (id: string) => {
    const [row] = await db
      .select({
        content: schema.documents.content,
        draftContent: schema.documents.draftContent,
        draftVersion: schema.documents.draftVersion,
        draftBaseRevision: schema.documents.draftBaseRevision,
      })
      .from(schema.documents)
      .where(eq(schema.documents.id, id));

    return row;
  };

  beforeAll(async () => {
    pglite = new PGlite();
    db = drizzle(pglite, { schema });
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

  it('reports health', async () => {
    expect(await call('GET', '/health')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('allows cross-origin writes from the web app', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/documents/00000000-0000-4000-8000-000000000000',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT' },
    });
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
  });

  it('creates and reads a document', async () => {
    const { status, body } = await call('POST', '/documents', { title: 'Draft', content: 'Hello world' });
    expect(status).toBe(201);
    const created = body as Document;
    expect(created).toMatchObject({ title: 'Draft', content: 'Hello world', revision: 1 });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await call('GET', `/documents/${created.id}`)).toEqual({ status: 200, body: created });
  });

  it('starts the draft equal to the first revision', async () => {
    const doc = await create('Brouillon', 'Il était une fois…');
    expect(await draftOf(doc.id)).toEqual({
      content: 'Il était une fois…',
      draftContent: 'Il était une fois…',
      draftVersion: 1,
      draftBaseRevision: 1,
    });
  });

  it('keeps the draft equal to the saved content on update', async () => {
    const doc = await create('Essai', 'v1');
    await call('PUT', `/documents/${doc.id}`, { title: 'Essai', content: 'v2', baseRevision: 1 });
    expect(await draftOf(doc.id)).toEqual({ content: 'v2', draftContent: 'v2', draftVersion: 2, draftBaseRevision: 2 });

    // A title-only change creates a revision but leaves the draft text, and its version, as they were.
    await call('PUT', `/documents/${doc.id}`, { title: 'Essai !', content: 'v2', baseRevision: 2 });
    expect(await draftOf(doc.id)).toEqual({ content: 'v2', draftContent: 'v2', draftVersion: 2, draftBaseRevision: 3 });

    // A no-op save and a rejected save do not touch the draft.
    await call('PUT', `/documents/${doc.id}`, { title: 'Essai !', content: 'v2', baseRevision: 3 });
    await call('PUT', `/documents/${doc.id}`, { title: 'Essai', content: 'stale', baseRevision: 1 });
    expect(await draftOf(doc.id)).toEqual({ content: 'v2', draftContent: 'v2', draftVersion: 2, draftBaseRevision: 3 });
  });

  it('validates the payload', async () => {
    expect((await call('POST', '/documents', { title: 'No content' })).status).toBe(400);
    expect((await call('POST', '/documents', { title: 'x', content: 'y', extra: true })).status).toBe(400);
    expect((await call('POST', '/documents', { title: 'x'.repeat(201), content: '' })).status).toBe(400);
  });

  it('answers 404 for unknown documents and 400 for malformed ids', async () => {
    expect((await call('GET', '/documents/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await call('GET', '/documents/not-a-uuid')).status).toBe(400);
  });

  it('lists documents, most recently updated first', async () => {
    const first = await create('First', 'a');
    const second = await create('Second', 'b');
    await call('PUT', `/documents/${first.id}`, { title: 'First', content: 'a2', baseRevision: 1 });

    const list = (await call('GET', '/documents')).body as DocumentSummary[];
    const ids = list.map((doc) => doc.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(list[0]).not.toHaveProperty('content');
  });

  it('keeps a revision per save and serves each one', async () => {
    const doc = await create('Essay', 'v1');
    const v2 = (await call('PUT', `/documents/${doc.id}`, { title: 'Essay', content: 'v2', baseRevision: 1 }))
      .body as Document;
    expect(v2).toMatchObject({ content: 'v2', revision: 2 });

    const v3 = (await call('PUT', `/documents/${doc.id}`, { title: 'Essay!', content: 'v3', baseRevision: 2 }))
      .body as Document;
    expect(v3).toMatchObject({ title: 'Essay!', content: 'v3', revision: 3 });

    const revisions = (await call('GET', `/documents/${doc.id}/revisions`)).body as RevisionSummary[];
    expect(revisions.map((rev) => rev.revision)).toEqual([3, 2, 1]);
    expect(revisions[0]).not.toHaveProperty('content');

    const first = (await call('GET', `/documents/${doc.id}/revisions/1`)).body as Revision;
    expect(first).toMatchObject({ documentId: doc.id, revision: 1, title: 'Essay', content: 'v1' });
    expect((await call('GET', `/documents/${doc.id}/revisions/9`)).status).toBe(404);
  });

  it('does not create a revision when nothing changed', async () => {
    const doc = await create('Same', 'same');
    const { status, body } = await call('PUT', `/documents/${doc.id}`, {
      title: 'Same',
      content: 'same',
      baseRevision: 1,
    });
    expect(status).toBe(200);
    expect((body as Document).revision).toBe(1);
  });

  it('rejects a save based on a stale revision', async () => {
    const doc = await create('Shared', 'v1');
    await call('PUT', `/documents/${doc.id}`, { title: 'Shared', content: 'from web', baseRevision: 1 });

    const conflict = await call('PUT', `/documents/${doc.id}`, {
      title: 'Shared',
      content: 'from phone',
      baseRevision: 1,
    });
    expect(conflict.status).toBe(409);
    expect(((await call('GET', `/documents/${doc.id}`)).body as Document).content).toBe('from web');
  });

  it('deletes a document with its history', async () => {
    const doc = await create('Trash', 'bye');
    expect((await call('DELETE', `/documents/${doc.id}`)).status).toBe(204);
    expect((await call('GET', `/documents/${doc.id}`)).status).toBe(404);
    expect((await call('GET', `/documents/${doc.id}/revisions`)).status).toBe(404);
    expect((await call('DELETE', `/documents/${doc.id}`)).status).toBe(404);
  });
});
