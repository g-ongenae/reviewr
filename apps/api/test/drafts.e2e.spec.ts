import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  Document,
  DocumentDraft,
  DraftConflictBody,
  RevisionSummary,
  StaleRevisionBody,
  UnsavedDraftBody,
} from '@reviewr/shared';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

const unknownId: string = '00000000-0000-4000-8000-000000000000';

/**
 * End-to-end tests of the draft (autosave) endpoint and of how the old `PUT /documents/:id` respects drafts.
 */
describe('Drafts API', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;

  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const response = await app.inject({ method, url, payload });

    return { status: response.statusCode, body: response.body.length > 0 ? (response.json() as unknown) : undefined };
  };

  const create = async (content: string): Promise<Document> =>
    (await call('POST', '/documents', { title: 'Brouillon', content })).body as Document;

  const saveDraft = async (id: string, content: string, draftVersion: number) =>
    call('PUT', `/documents/${id}/draft`, { content, draftVersion });

  const get = async (id: string): Promise<Document> => (await call('GET', `/documents/${id}`)).body as Document;

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

  it('exposes the draft on documents', async () => {
    const doc = await create('Il était une fois…');
    expect(doc.draft).toEqual({ content: 'Il était une fois…', draftVersion: 1, baseRevision: 1 });
    expect((await get(doc.id)).draft).toEqual(doc.draft);
  });

  it('saves a draft without touching the head', async () => {
    const doc = await create('v1');
    const saved = await saveDraft(doc.id, 'v1, suite', 1);
    expect(saved).toEqual({
      status: 200,
      body: { content: 'v1, suite', draftVersion: 2, baseRevision: 1 } satisfies DocumentDraft,
    });

    const after = await get(doc.id);
    expect(after).toMatchObject({ content: 'v1', revision: 1, draft: saved.body });
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(doc.updatedAt));
    expect(((await saveDraft(doc.id, 'v1, suite et fin', 2)).body as DocumentDraft).draftVersion).toBe(3);
  });

  it('creates no revision', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    await saveDraft(doc.id, 'v3', 2);
    const revisions = (await call('GET', `/documents/${doc.id}/revisions`)).body as RevisionSummary[];
    expect(revisions.map((rev) => rev.revision)).toEqual([1]);
  });

  it('treats saving the stored text as a no-op', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'v2', 1);
    const before = await get(doc.id);

    expect(await saveDraft(doc.id, 'v2', 2)).toEqual({
      status: 200,
      body: { content: 'v2', draftVersion: 2, baseRevision: 1 },
    });
    expect(await get(doc.id)).toEqual(before);
  });

  it('answers 409 with the server draft on a stale draftVersion, and keeps that draft', async () => {
    const doc = await create('v1');
    await saveDraft(doc.id, 'phone', 1);

    const { status, body } = await saveDraft(doc.id, 'web', 1);
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'draft_conflict',
      draft: { content: 'phone', draftVersion: 2, baseRevision: 1 },
    } satisfies Omit<DraftConflictBody, 'message'>);
    expect((body as DraftConflictBody).message).toEqual(expect.any(String));
    expect((await get(doc.id)).draft).toEqual({ content: 'phone', draftVersion: 2, baseRevision: 1 });

    // A version from the future is stale too.
    expect((await saveDraft(doc.id, 'web', 7)).status).toBe(409);
  });

  it('gives exactly one 409 for two concurrent saves of the same draftVersion', async () => {
    const doc = await create('v1');
    const results = await Promise.all([saveDraft(doc.id, 'one', 1), saveDraft(doc.id, 'two', 1)]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409]);

    const winner = results.find((result) => result.status === 200)?.body as DocumentDraft;
    const loser = results.find((result) => result.status === 409)?.body as DraftConflictBody;
    expect(winner.draftVersion).toBe(2);
    expect(loser.draft).toEqual(winner);
    expect((await get(doc.id)).draft).toEqual(winner);
  });

  it('answers 404 for an unknown document and 400 for a malformed id', async () => {
    expect((await saveDraft(unknownId, 'x', 1)).status).toBe(404);
    expect((await call('PUT', '/documents/not-a-uuid/draft', { content: 'x', draftVersion: 1 })).status).toBe(400);
  });

  it('validates the payload', async () => {
    const doc = await create('v1');
    const url = `/documents/${doc.id}/draft`;
    expect((await call('PUT', url, { draftVersion: 1 })).status).toBe(400);
    expect((await call('PUT', url, { content: 'x' })).status).toBe(400);
    expect((await call('PUT', url, { content: 42, draftVersion: 1 })).status).toBe(400);
    expect((await call('PUT', url, { content: 'x', draftVersion: 0 })).status).toBe(400);
    expect((await call('PUT', url, { content: 'x', draftVersion: 1.5 })).status).toBe(400);
    expect((await call('PUT', url, { content: 'x', draftVersion: '1' })).status).toBe(400);
    expect((await call('PUT', url, { content: 'x', draftVersion: 1, extra: true })).status).toBe(400);
    expect((await call('PUT', url, { content: 'x'.repeat(1_000_001), draftVersion: 1 })).status).toBe(400);
    expect((await get(doc.id)).draft).toEqual({ content: 'v1', draftVersion: 1, baseRevision: 1 });
  });

  describe('PUT /documents/:id (save + revision)', () => {
    it('answers 409 instead of overwriting a draft that differs from the head', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'autosaved', 1);

      const { status, body } = await call('PUT', `/documents/${doc.id}`, {
        title: 'Brouillon',
        content: 'old client',
        baseRevision: 1,
      });
      expect(status).toBe(409);
      expect(body).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: 'unsaved_draft',
        draft: { content: 'autosaved', draftVersion: 2, baseRevision: 1 },
      } satisfies Omit<UnsavedDraftBody, 'message'>);
      expect(await get(doc.id)).toMatchObject({
        content: 'v1',
        revision: 1,
        draft: { content: 'autosaved', draftVersion: 2 },
      });
    });

    it('turns the draft into a revision when it saves the draft text', async () => {
      const doc = await create('v1');
      await saveDraft(doc.id, 'autosaved', 1);

      const { status, body } = await call('PUT', `/documents/${doc.id}`, {
        title: 'Brouillon',
        content: 'autosaved',
        baseRevision: 1,
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({
        content: 'autosaved',
        revision: 2,
        draft: { content: 'autosaved', draftVersion: 2, baseRevision: 2 },
      });
    });

    it('gives the stale-revision 409 a code and the current revision', async () => {
      const doc = await create('v1');
      await call('PUT', `/documents/${doc.id}`, { title: 'Brouillon', content: 'v2', baseRevision: 1 });

      const { status, body } = await call('PUT', `/documents/${doc.id}`, {
        title: 'Brouillon',
        content: 'v2 bis',
        baseRevision: 1,
      });
      expect(status).toBe(409);
      expect(body).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: 'stale_revision',
        revision: 2,
      } satisfies Omit<StaleRevisionBody, 'message'>);
    });
  });
});
