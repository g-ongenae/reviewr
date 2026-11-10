/* eslint-disable no-null/no-null -- the API sends null for an untitled document */
import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  clientFeaturesHeader,
  type Document,
  type DocumentSummary,
  type Revision,
  type RevisionSummary,
} from '@reviewr/shared';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

/** Headers of the web and mobile apps that understand absent titles. */
const currentClient = { [clientFeaturesHeader]: 'nullable-title' };

/**
 * End-to-end tests of untitled documents: a title can be absent, and old apps still send and read `''`.
 */
describe('Document titles', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;

  /** Request from a current app, unless other headers are given (`{}`: an app built before absent titles). */
  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
    headers: Record<string, string> = currentClient,
  ) => {
    const response = await app.inject({ method, url, payload, headers });

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

  it('answers an empty title instead of null to apps that do not announce absent titles', async () => {
    const created = await create({ content: 'v1' });
    const id = created.id;
    const old = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      (await call(method, url, payload, {})).body;

    // Every response shape: created, saved, single, list, revision and revision list.
    expect(await old('POST', '/documents', { title: '', content: 'old app' })).toMatchObject({ title: '' });
    expect(await old('PUT', `/documents/${id}`, { title: '', content: 'v2', baseRevision: 1 })).toMatchObject({
      title: '',
      revision: 2,
    });
    expect(await old('GET', `/documents/${id}`)).toMatchObject({ title: '', content: 'v2' });
    const list = (await old('GET', '/documents')) as DocumentSummary[];
    expect(list.length).toBeGreaterThan(1);
    for (const doc of list) {
      expect(typeof doc.title).toBe('string');
    }
    expect(list.find((doc) => doc.id === id)).toMatchObject({ title: '' });
    expect(await old('GET', `/documents/${id}/revisions`)).toEqual([
      expect.objectContaining({ revision: 2, title: '' }),
      expect.objectContaining({ revision: 1, title: '' }),
    ]);
    expect((await old('GET', `/documents/${id}/revisions/1`)) as Revision).toMatchObject({ title: '', content: 'v1' });

    // A titled document is answered as it is.
    const titled = await create({ title: 'Titre', content: '' });
    expect(await old('GET', `/documents/${titled.id}`)).toMatchObject({ title: 'Titre' });

    // The same untitled document, read by a current app: null everywhere.
    expect((await call('GET', `/documents/${id}`)).body).toMatchObject({ title: null });
    expect(((await call('GET', '/documents')).body as DocumentSummary[]).find((doc) => doc.id === id)).toMatchObject({
      title: null,
    });
    expect((await call('GET', `/documents/${id}/revisions`)).body).toEqual([
      expect.objectContaining({ title: null }),
      expect.objectContaining({ title: null }),
    ]);
    expect((await call('GET', `/documents/${id}/revisions/1`)).body).toMatchObject({ title: null });
    // The feature can be one of several.
    expect(
      (await call('GET', `/documents/${id}`, undefined, { [clientFeaturesHeader]: 'later, nullable-title' })).body,
    ).toMatchObject({ title: null });
  });

  it('lets an old app read an untitled document and save it back unchanged without a new revision', async () => {
    const doc = await create({ content: 'texte' });
    const read = (await call('GET', `/documents/${doc.id}`, undefined, {})).body as Document;
    expect(read.title).toBe('');

    const saved = (
      await call('PUT', `/documents/${doc.id}`, { title: read.title, content: read.content, baseRevision: 1 }, {})
    ).body as Document;
    expect(saved).toMatchObject({ title: '', revision: 1 });
    expect(await revisionsOf(doc.id)).toHaveLength(1);
  });

  it('tells caches that the answer depends on the features header', async () => {
    const doc = await create({ content: 'texte' });

    for (const headers of [{}, currentClient]) {
      const response = await app.inject({
        method: 'GET',
        url: `/documents/${doc.id}`,
        headers: { ...headers, origin: 'http://localhost:5173' },
      });
      const vary = String(response.headers.vary)
        .toLowerCase()
        .split(',')
        .map((value) => value.trim());

      expect(vary).toContain(clientFeaturesHeader.toLowerCase());
      expect(vary.filter((value) => value === clientFeaturesHeader.toLowerCase())).toHaveLength(1);
    }
  });

  it('lets the web app send the features header across origins', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/documents',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': `content-type,${clientFeaturesHeader.toLowerCase()}`,
      },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      clientFeaturesHeader.toLowerCase(),
    );
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
