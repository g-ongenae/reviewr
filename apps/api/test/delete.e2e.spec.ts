import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Document, DocumentChangedBody } from '@reviewr/shared';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

const unknownId: string = '00000000-0000-4000-8000-000000000000';

/**
 * End-to-end tests of `DELETE /documents/:id` with what the client last saw (`?revision=&draftVersion=`). The
 * row lock under concurrent writes is covered on a real PostgreSQL in `concurrency.pg.spec.ts`.
 */
describe('Delete with what the client saw', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => {
    const response = await app.inject({ method, url, payload });

    return { status: response.statusCode, body: response.body.length > 0 ? (response.json() as unknown) : undefined };
  };

  const create = async (content: string): Promise<Document> =>
    (await call('POST', '/documents', { title: 'Chapitre', content })).body as Document;

  const remove = async (id: string, query: string = '') => call('DELETE', `/documents/${id}${query}`);

  const exists = async (id: string): Promise<boolean> => (await call('GET', `/documents/${id}`)).status === 200;

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

  it('deletes the document when nothing moved since the client read it', async () => {
    const doc = await create('matin');
    await call('PUT', `/documents/${doc.id}/draft`, { content: 'matin, suite', draftVersion: 1 });

    expect(await remove(doc.id, '?revision=1&draftVersion=2')).toEqual({ status: 204, body: undefined });
    expect(await exists(doc.id)).toBe(false);
    expect((await call('GET', `/documents/${doc.id}/revisions`)).status).toBe(404);
  });

  it('deletes a document without a revision yet, seen at revision 0', async () => {
    const created = await call('POST', '/documents', {
      id: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
      title: 'Chapitre',
      content: 'premier jet',
      draftOnly: true,
    });
    const doc = created.body as Document;

    expect((await remove(doc.id, '?revision=0&draftVersion=1')).status).toBe(204);
    expect(await exists(doc.id)).toBe(false);
  });

  it('refuses with 409 and deletes nothing when the draft moved since', async () => {
    const doc = await create('matin');
    await call('PUT', `/documents/${doc.id}/draft`, { content: 'matin, puis deux pages', draftVersion: 1 });

    const refused = await remove(doc.id, '?revision=1&draftVersion=1');
    expect(refused).toEqual({
      status: 409,
      body: {
        statusCode: 409,
        error: 'Conflict',
        code: 'document_changed',
        message: expect.any(String) as string,
        revision: 1,
        draft: { content: 'matin, puis deux pages', draftVersion: 2, baseRevision: 1 },
      } satisfies DocumentChangedBody,
    });
    expect(await exists(doc.id)).toBe(true);
  });

  it('refuses with 409 and deletes nothing when a version was saved since, even with the draft unchanged', async () => {
    const doc = await create('matin');
    await call('PUT', `/documents/${doc.id}/draft`, { content: 'soir', draftVersion: 1 });
    // The draft is saved as a version as it is: its draftVersion does not move, the head does.
    await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 2, baseRevision: 1 });

    const refused = await remove(doc.id, '?revision=1&draftVersion=2');
    expect(refused).toMatchObject({
      status: 409,
      body: { code: 'document_changed', revision: 2, draft: { content: 'soir', draftVersion: 2, baseRevision: 2 } },
    });
    expect(await exists(doc.id)).toBe(true);
    // Having read it again, the client can delete it.
    expect((await remove(doc.id, '?revision=2&draftVersion=2')).status).toBe(204);
  });

  it('deletes as before without a precondition, as builds already installed send it', async () => {
    const doc = await create('matin');
    await call('PUT', `/documents/${doc.id}/draft`, { content: 'soir', draftVersion: 1 });

    expect((await remove(doc.id)).status).toBe(204);
    expect(await exists(doc.id)).toBe(false);
  });

  it('answers 404 for a document already deleted, with or without a precondition', async () => {
    expect((await remove(unknownId)).status).toBe(404);
    expect((await remove(unknownId, '?revision=1&draftVersion=1')).status).toBe(404);
  });

  it.each([
    ['only a revision', '?revision=1'],
    ['only a draftVersion', '?draftVersion=1'],
    ['an empty revision', '?revision=&draftVersion=1'],
    ['a negative revision', '?revision=-1&draftVersion=1'],
    ['a fractional draftVersion', '?revision=1&draftVersion=1.5'],
    ['a zero draftVersion', '?revision=1&draftVersion=0'],
    ['a word', '?revision=one&draftVersion=1'],
    ['a parameter sent twice', '?revision=1&revision=1&draftVersion=1'],
    ['an unknown parameter', '?revision=1&draftVersion=1&force=1'],
  ])('refuses %s with 400 and deletes nothing', async (_case: string, query: string) => {
    const doc = await create('matin');

    expect((await remove(doc.id, query)).status).toBe(400);
    expect(await exists(doc.id)).toBe(true);
  });
});
