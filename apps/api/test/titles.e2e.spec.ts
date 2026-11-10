/* eslint-disable no-null/no-null -- the API sends null for an untitled document */
import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Document, DocumentSummary, RevisionSummary } from '@reviewr/shared';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

/**
 * End-to-end tests of untitled documents: a title can be absent, and old apps still send `''`.
 */
describe('Document titles', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;

  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const response = await app.inject({ method, url, payload });

    return { status: response.statusCode, body: response.body.length > 0 ? (response.json() as unknown) : undefined };
  };

  const create = async (payload: object): Promise<Document> => {
    const { status, body } = await call('POST', '/documents', payload);
    expect(status).toBe(201);

    return body as Document;
  };

  const revisionsOf = async (id: string): Promise<RevisionSummary[]> =>
    (await call('GET', `/documents/${id}/revisions`)).body as RevisionSummary[];

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite, { schema });
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

  it('creates an untitled document when no title is sent', async () => {
    const created = await create({ content: 'Je commence à écrire' });

    expect(created).toMatchObject({ title: null, content: 'Je commence à écrire', revision: 1 });
    expect((await call('GET', `/documents/${created.id}`)).body).toMatchObject({ title: null });
    expect(await revisionsOf(created.id)).toEqual([expect.objectContaining({ revision: 1, title: null })]);
    const list = (await call('GET', '/documents')).body as DocumentSummary[];
    expect(list.find((doc) => doc.id === created.id)).toMatchObject({ title: null });
  });

  it('stores a null, empty or blank title as no title', async () => {
    for (const title of [null, '', '   ', ' \n\t ']) {
      expect(await create({ title, content: 'texte' })).toMatchObject({ title: null, content: 'texte' });
    }
  });

  it('keeps a title as it was typed', async () => {
    expect(await create({ title: '  Chapitre 1 ', content: '' })).toMatchObject({ title: '  Chapitre 1 ' });
  });

  it('rejects a title that is not a string or too long', async () => {
    expect((await call('POST', '/documents', { title: 42, content: '' })).status).toBe(400);
    expect((await call('POST', '/documents', { title: 'x'.repeat(201), content: '' })).status).toBe(400);
    expect((await call('POST', '/documents', { title: ' '.repeat(201), content: '' })).status).toBe(201);
  });

  it('removes the title when a save sends none, and keeps it in the earlier revision', async () => {
    const doc = await create({ title: 'Brouillon', content: 'v1' });

    const saved = (await call('PUT', `/documents/${doc.id}`, { content: 'v1', baseRevision: 1 })).body as Document;
    expect(saved).toMatchObject({ title: null, content: 'v1', revision: 2 });
    expect((await revisionsOf(doc.id)).map((revision) => revision.title)).toEqual([null, 'Brouillon']);

    const renamed = (await call('PUT', `/documents/${doc.id}`, { title: 'Final', content: 'v1', baseRevision: 2 }))
      .body as Document;
    expect(renamed).toMatchObject({ title: 'Final', revision: 3 });
  });

  it('treats an old app sending an empty title like a new one sending none', async () => {
    const doc = await create({ title: '', content: 'v1' });

    // Same content, still untitled: nothing changed, so no revision is created.
    for (const payload of [
      { title: '', content: 'v1', baseRevision: 1 },
      { content: 'v1', baseRevision: 1 },
      { title: null, content: 'v1', baseRevision: 1 },
    ]) {
      expect((await call('PUT', `/documents/${doc.id}`, payload)).body).toMatchObject({ title: null, revision: 1 });
    }
    expect(await revisionsOf(doc.id)).toHaveLength(1);
  });
});
