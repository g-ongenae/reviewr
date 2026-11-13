/* eslint-disable no-null/no-null -- the API sends null for an untitled document and an unnamed version */
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
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

const unknownId: string = '00000000-0000-4000-8000-000000000000';
const currentClient = { [clientFeaturesHeader]: 'nullable-title' };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

/**
 * End-to-end tests of `PATCH /documents/:id` (rename) and `PATCH /documents/:id/revisions/:revision` (version label).
 */
describe('Rename API', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;

  /** Request from a current app, unless other headers are given (`{}`: an app built before absent titles). */
  const call = async (
    method: Method,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = currentClient,
  ) => {
    const response = await app.inject({ method, url, payload: payload as object, headers });

    return { status: response.statusCode, body: response.body.length > 0 ? (response.json() as unknown) : undefined };
  };

  const create = async (content: string, title: string | null = 'Chapitre'): Promise<Document> =>
    (await call('POST', '/documents', { title, content })).body as Document;

  const get = async (id: string): Promise<Document> => (await call('GET', `/documents/${id}`)).body as Document;

  const rename = async (id: string, payload: unknown, headers?: Record<string, string>) =>
    call('PATCH', `/documents/${id}`, payload, headers);

  const nameRevision = async (id: string, revision: number | string, payload: unknown) =>
    call('PATCH', `/documents/${id}/revisions/${revision}`, payload);

  const listRevisions = async (id: string): Promise<Revision[]> =>
    Promise.all(
      ((await call('GET', `/documents/${id}/revisions`)).body as RevisionSummary[]).map(
        async (summary) => (await call('GET', `/documents/${id}/revisions/${summary.revision}`)).body as Revision,
      ),
    );

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

  describe('PATCH /documents/:id', () => {
    it('renames a document without touching its content, draft or revisions', async () => {
      const doc = await create('v1');
      await call('PUT', `/documents/${doc.id}/draft`, { content: 'v2 en cours', draftVersion: 1 });
      const before = await get(doc.id);
      const revisionsBefore = await listRevisions(doc.id);

      const { status, body } = await rename(doc.id, { title: '  Chapitre 1 ' });

      expect(status).toBe(200);
      const renamed = body as Document;
      expect(renamed).toEqual({ ...before, title: '  Chapitre 1 ', updatedAt: renamed.updatedAt });
      expect(renamed.draft).toEqual({ content: 'v2 en cours', draftVersion: 2, baseRevision: 1 });
      expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
      expect(await get(doc.id)).toEqual(renamed);
      // Revisions are snapshots: the one saved before keeps its title.
      expect(await listRevisions(doc.id)).toEqual(revisionsBefore);
      expect(revisionsBefore).toEqual([expect.objectContaining({ revision: 1, title: 'Chapitre', content: 'v1' })]);
    });

    it('clears the title with null, an empty or a blank string', async () => {
      const doc = await create('v1');
      for (const title of [null, '', '  \n\t ']) {
        await rename(doc.id, { title: 'Titre' });
        expect(await rename(doc.id, { title })).toMatchObject({
          status: 200,
          body: { title: null },
        });
      }
      expect((await get(doc.id)).title).toBeNull();
    });

    it('changes nothing when the title sent is the stored one', async () => {
      const doc = await create('v1', 'Pareil');

      expect(await rename(doc.id, { title: 'Pareil' })).toEqual({ status: 200, body: doc });
      expect(await get(doc.id)).toEqual(doc);
    });

    it('shows the new title in the list, first', async () => {
      const doc = await create('v1');
      await create('a later document');

      await rename(doc.id, { title: 'Renommé' });

      const list = (await call('GET', '/documents')).body as DocumentSummary[];
      expect(list[0]).toMatchObject({ id: doc.id, title: 'Renommé', revision: 1 });
    });

    it('lets autosave and "save version" go on, and the next version carries the new title', async () => {
      const doc = await create('v1');
      await rename(doc.id, { title: 'Nouveau titre' });

      expect((await call('PUT', `/documents/${doc.id}/draft`, { content: 'v2', draftVersion: 1 })).status).toBe(200);
      const saved = await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 2, baseRevision: 1 });

      expect(saved).toMatchObject({
        status: 200,
        body: { title: 'Nouveau titre', content: 'v2', revision: 2 },
      });
      expect((await listRevisions(doc.id)).map(({ revision, title }) => ({ revision, title }))).toEqual([
        { revision: 2, title: 'Nouveau titre' },
        { revision: 1, title: 'Chapitre' },
      ]);
    });

    it('answers an empty title to apps that do not announce absent titles', async () => {
      const doc = await create('v1');

      expect(await rename(doc.id, { title: null }, {})).toMatchObject({
        status: 200,
        body: { title: '' },
      });
      expect((await get(doc.id)).title).toBeNull();
    });

    it('answers 404 for an unknown document', async () => {
      expect((await rename(unknownId, { title: 'x' })).status).toBe(404);
    });

    it.each([
      ['an empty body', {}],
      ['no body', undefined],
      ['a number', { title: 42 }],
      ['an array', { title: ['a'] }],
      ['a title too long', { title: 'x'.repeat(201) }],
      ['an unknown property', { title: 'x', content: 'remplacé' }],
    ])('rejects %s', async (_case: string, payload: unknown) => {
      const doc = await create('v1');

      expect((await rename(doc.id, payload)).status).toBe(400);
      expect(await get(doc.id)).toEqual(doc);
    });

    it('rejects a malformed id', async () => {
      expect((await rename('not-a-uuid', { title: 'x' })).status).toBe(400);
    });

    it('accepts the longest title', async () => {
      const doc = await create('v1');

      expect((await rename(doc.id, { title: 'x'.repeat(200) })).status).toBe(200);
    });
  });

  describe('PATCH /documents/:id/revisions/:revision', () => {
    it('names, renames and clears the label of a version, and nothing else', async () => {
      const doc = await create('v1');
      const [revision] = await listRevisions(doc.id);
      const document = await get(doc.id);

      const named = await nameRevision(doc.id, 1, { name: '  Relu par Alex ' });
      expect(named).toEqual({
        status: 200,
        body: {
          documentId: doc.id,
          revision: 1,
          title: 'Chapitre',
          name: 'Relu par Alex',
          createdAt: revision?.createdAt,
        },
      });
      expect(await nameRevision(doc.id, 1, { name: 'Relu par Alex' })).toEqual(named);
      expect((await nameRevision(doc.id, 1, { name: 'Envoyé' })).body).toMatchObject({ name: 'Envoyé' });
      expect(await listRevisions(doc.id)).toEqual([{ ...revision, name: 'Envoyé' }]);

      for (const name of [null, '', '   ']) {
        await nameRevision(doc.id, 1, { name: 'x' });
        expect((await nameRevision(doc.id, 1, { name })).body).toMatchObject({ name: null });
      }
      expect(await listRevisions(doc.id)).toEqual([revision]);
      // The document is not touched, not even its updatedAt.
      expect(await get(doc.id)).toEqual(document);
    });

    it('names an older version', async () => {
      const doc = await create('v1');
      await call('PUT', `/documents/${doc.id}/draft`, { content: 'v2', draftVersion: 1 });
      await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 2, baseRevision: 1 });

      await nameRevision(doc.id, 1, { name: 'Premier jet' });

      expect((await listRevisions(doc.id)).map(({ revision, name }) => ({ revision, name }))).toEqual([
        { revision: 2, name: null },
        { revision: 1, name: 'Premier jet' },
      ]);
    });

    it('answers an empty title to apps that do not announce absent titles', async () => {
      const doc = await create('v1', null);

      const response = await call('PATCH', `/documents/${doc.id}/revisions/1`, { name: 'v1' }, {});
      expect(response.body).toMatchObject({ title: '', name: 'v1' });
    });

    it('answers 404 for an unknown document or revision', async () => {
      const doc = await create('v1');

      expect((await nameRevision(unknownId, 1, { name: 'x' })).status).toBe(404);
      expect((await nameRevision(doc.id, 2, { name: 'x' })).status).toBe(404);
      expect((await nameRevision(doc.id, 0, { name: 'x' })).status).toBe(404);
    });

    it.each([
      ['an empty body', {}],
      ['no body', undefined],
      ['a number', { name: 42 }],
      ['a name too long', { name: 'x'.repeat(201) }],
      ['an unknown property', { name: 'x', title: 'autre' }],
    ])('rejects %s', async (_case: string, payload: unknown) => {
      const doc = await create('v1');
      const revisions = await listRevisions(doc.id);

      expect((await nameRevision(doc.id, 1, payload)).status).toBe(400);
      expect(await listRevisions(doc.id)).toEqual(revisions);
    });

    it('accepts the longest name, counted after trimming', async () => {
      const doc = await create('v1');

      expect((await nameRevision(doc.id, 1, { name: ` ${'x'.repeat(200)} ` })).status).toBe(200);
    });

    it('rejects a malformed id or revision number', async () => {
      const doc = await create('v1');

      expect((await nameRevision('not-a-uuid', 1, { name: 'x' })).status).toBe(400);
      expect((await nameRevision(doc.id, 'abc', { name: 'x' })).status).toBe(400);
      expect((await nameRevision(doc.id, '1.5', { name: 'x' })).status).toBe(400);
    });
  });

  describe('the old PUT /documents/:id after a rename', () => {
    it('applies the title it is sent, as before: an app that loaded the old title puts it back', async () => {
      // Known limit, kept on purpose: the server cannot tell a title loaded before the rename from one the
      // writer chose, and guessing was wrong both ways. It ends when the apps rename through PATCH.
      const doc = await create('v1', 'Ancien');
      await rename(doc.id, { title: 'Nouveau' });

      const saved = await call('PUT', `/documents/${doc.id}`, { title: 'Ancien', content: 'v2', baseRevision: 1 }, {});

      expect(saved).toMatchObject({ status: 200, body: { title: 'Ancien', content: 'v2', revision: 2 } });
      expect((await listRevisions(doc.id))[0]).toMatchObject({ revision: 2, title: 'Ancien', content: 'v2' });
    });

    it('applies a title the writer changed, with or without a rename in between', async () => {
      const renamed = await create('v1', 'Ancien');
      await rename(renamed.id, { title: 'Nouveau' });
      const afterRename = await call('PUT', `/documents/${renamed.id}`, {
        title: 'Troisième',
        content: 'v2',
        baseRevision: 1,
      });
      expect(afterRename.body).toMatchObject({ title: 'Troisième', revision: 2 });

      const plain = await create('v1', 'Ancien');
      const saved = await call('PUT', `/documents/${plain.id}`, { title: 'Autre', content: 'v1', baseRevision: 1 });
      expect(saved.body).toMatchObject({ title: 'Autre', revision: 2 });
    });

    it('keeps a pending draft as a revision under the renamed title, then answers 409', async () => {
      const doc = await create('v1', 'Ancien');
      await call('PUT', `/documents/${doc.id}/draft`, { content: 'brouillon', draftVersion: 1 });
      await rename(doc.id, { title: 'Nouveau' });

      const saved = await call('PUT', `/documents/${doc.id}`, { title: 'Ancien', content: 'v2', baseRevision: 1 });

      expect(saved).toMatchObject({ status: 409, body: { code: 'stale_revision', revision: 2 } });
      expect((await listRevisions(doc.id))[0]).toMatchObject({ revision: 2, title: 'Nouveau', content: 'brouillon' });
      expect(await get(doc.id)).toMatchObject({ title: 'Nouveau', content: 'brouillon', revision: 2 });
    });

    it('still answers 409 to a save based on an older revision, and keeps the rename', async () => {
      const doc = await create('v1', 'Ancien');
      await call('PUT', `/documents/${doc.id}`, { title: 'Ancien', content: 'v2', baseRevision: 1 });
      await rename(doc.id, { title: 'Nouveau' });

      const stale = await call('PUT', `/documents/${doc.id}`, { title: 'Ancien', content: 'v3', baseRevision: 1 });

      expect(stale).toMatchObject({ status: 409, body: { code: 'stale_revision', revision: 2 } });
      expect(await get(doc.id)).toMatchObject({ title: 'Nouveau', content: 'v2', revision: 2 });
    });
  });

  it('allows cross-origin PATCH from the web app', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: `/documents/${unknownId}/revisions/1`,
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': `content-type,${clientFeaturesHeader.toLowerCase()}`,
      },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(String(response.headers['access-control-allow-methods']).split(/,\s*/)).toContain('PATCH');
  });
});
