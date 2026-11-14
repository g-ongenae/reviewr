/* eslint-disable no-null/no-null -- the API sends null for the base of a draft without a revision */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  CreateDraftDocumentInput,
  Document,
  DocumentDraft,
  DocumentSummary,
  DraftConflictBody,
  Revision,
  RevisionSummary,
  StaleRevisionBody,
} from '@reviewr/shared';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { databaseToken, migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';

/**
 * End-to-end tests of documents created with only a draft (`draftOnly`), of every endpoint on such a document,
 * and of the retry-safe creation with a client-generated id.
 */
describe('Documents with only a draft', () => {
  let app: NestFastifyApplication;
  let pglite: PGlite;

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
    const response = await app.inject({ method, url, payload });

    return { status: response.statusCode, body: response.body.length > 0 ? (response.json() as unknown) : undefined };
  };

  /** Create a draft-only document with a fresh client id, as the Composer will. */
  const createDraft = async (content: string, title: string = 'Brouillon'): Promise<Document> => {
    const input: CreateDraftDocumentInput = { id: randomUUID(), title, content, draftOnly: true };
    const created = await call('POST', '/documents', input);
    expect(created.status).toBe(201);

    return created.body as Document;
  };

  const get = async (id: string): Promise<Document> => (await call('GET', `/documents/${id}`)).body as Document;

  const revisionsOf = async (id: string): Promise<RevisionSummary[]> =>
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

  describe('creation', () => {
    it('creates a document with a draft and no revision', async () => {
      const doc = await createDraft('Il était une fois…');

      expect(doc).toMatchObject({
        title: 'Brouillon',
        revision: 0,
        content: '',
        draft: { content: 'Il était une fois…', draftVersion: 1, baseRevision: null } satisfies DocumentDraft,
      });
      expect(await get(doc.id)).toEqual(doc);
      expect(await revisionsOf(doc.id)).toEqual([]);
    });

    it('accepts an empty draft, and needs no id', async () => {
      const created = await call('POST', '/documents', { content: '', draftOnly: true });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ revision: 0, content: '', draft: { content: '', baseRevision: null } });
    });

    it('still creates the first revision for the builds already installed', async () => {
      const created = await call('POST', '/documents', { title: 'Ancien', content: 'v1' });

      expect(created.body).toMatchObject({
        revision: 1,
        content: 'v1',
        draft: { content: 'v1', draftVersion: 1, baseRevision: 1 },
      });
      expect(await revisionsOf((created.body as Document).id)).toHaveLength(1);
    });

    it('refuses a draftOnly other than true, an id that is not a UUID, and both fields on PUT', async () => {
      expect((await call('POST', '/documents', { content: 'x', draftOnly: false })).status).toBe(400);
      expect((await call('POST', '/documents', { content: 'x', draftOnly: 'yes' })).status).toBe(400);
      expect((await call('POST', '/documents', { id: 'mon-id', content: 'x' })).status).toBe(400);

      const doc = await createDraft('x');
      const put = await call('PUT', `/documents/${doc.id}`, {
        title: 'Brouillon',
        content: 'x',
        baseRevision: 0,
        draftOnly: true,
      });
      expect(put.status).toBe(400);
      expect(await get(doc.id)).toEqual(doc);
    });
  });

  describe('reading', () => {
    it('lists the document at revision 0', async () => {
      const doc = await createDraft('liste');
      const list = (await call('GET', '/documents')).body as DocumentSummary[];

      expect(list.find((summary) => summary.id === doc.id)).toEqual({
        id: doc.id,
        title: 'Brouillon',
        revision: 0,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    });

    it('answers 404 for any revision', async () => {
      const doc = await createDraft('texte');

      expect((await call('GET', `/documents/${doc.id}/revisions/0`)).status).toBe(404);
      expect((await call('GET', `/documents/${doc.id}/revisions/1`)).status).toBe(404);
      expect((await call('PATCH', `/documents/${doc.id}/revisions/1`, { name: 'Nom' })).status).toBe(404);
    });
  });

  describe('autosave, rename and delete', () => {
    it('saves the draft, which stays based on no revision', async () => {
      const doc = await createDraft('a');
      const saved = await call('PUT', `/documents/${doc.id}/draft`, { content: 'ab', draftVersion: 1 });

      expect(saved).toEqual({ status: 200, body: { content: 'ab', draftVersion: 2, baseRevision: null } });
      expect(await get(doc.id)).toMatchObject({ revision: 0, content: '', draft: saved.body });

      const stale = await call('PUT', `/documents/${doc.id}/draft`, { content: 'ac', draftVersion: 1 });
      expect(stale.status).toBe(409);
      expect((stale.body as DraftConflictBody).draft).toEqual(saved.body);
    });

    it('renames without creating a revision', async () => {
      const doc = await createDraft('texte');
      const renamed = await call('PATCH', `/documents/${doc.id}`, { title: 'Nouveau' });

      expect(renamed.body).toMatchObject({ title: 'Nouveau', revision: 0, content: '', draft: doc.draft });
      expect(await revisionsOf(doc.id)).toEqual([]);
    });

    it('deletes the document', async () => {
      const doc = await createDraft('texte');

      expect((await call('DELETE', `/documents/${doc.id}`)).status).toBe(204);
      expect((await call('GET', `/documents/${doc.id}`)).status).toBe(404);
      expect((await call('GET', `/documents/${doc.id}/revisions`)).status).toBe(404);
    });
  });

  describe('POST /documents/:id/revisions', () => {
    it('saves the draft as revision 1, from a null base or from 0', async () => {
      for (const baseRevision of [null, 0]) {
        const doc = await createDraft('premier jet');
        const saved = await call('POST', `/documents/${doc.id}/revisions`, {
          name: 'Premier',
          draftVersion: 1,
          baseRevision,
        });

        expect(saved.status).toBe(200);
        expect(saved.body).toMatchObject({
          revision: 1,
          content: 'premier jet',
          draft: { content: 'premier jet', draftVersion: 1, baseRevision: 1 },
        });
        const revision = (await call('GET', `/documents/${doc.id}/revisions/1`)).body as Revision;
        expect(revision).toMatchObject({ revision: 1, title: 'Brouillon', name: 'Premier', content: 'premier jet' });
      }
    });

    it('creates no empty first version: an empty draft is a no-op', async () => {
      const doc = await createDraft('');
      const saved = await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 1, baseRevision: null });

      expect(saved).toEqual({ status: 200, body: doc });
      expect(await revisionsOf(doc.id)).toEqual([]);
    });

    it('answers a retry after a lost response with the version already created', async () => {
      const doc = await createDraft('texte');
      const input = { name: 'Relu', draftVersion: 1, baseRevision: null };
      const first = await call('POST', `/documents/${doc.id}/revisions`, input);
      const retry = await call('POST', `/documents/${doc.id}/revisions`, input);

      expect(retry).toEqual(first);
      expect(await revisionsOf(doc.id)).toHaveLength(1);
    });

    it('keeps the conflict rules', async () => {
      const doc = await createDraft('a');
      await call('PUT', `/documents/${doc.id}/draft`, { content: 'b', draftVersion: 1 });

      const staleDraft = await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 1, baseRevision: null });
      expect(staleDraft.status).toBe(409);
      expect(staleDraft.body).toMatchObject({ code: 'draft_conflict', draft: { content: 'b', draftVersion: 2 } });

      await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 2, baseRevision: null });
      await call('PUT', `/documents/${doc.id}/draft`, { content: 'c', draftVersion: 2 });
      // A client still at "no revision" while revision 1 was saved elsewhere.
      const staleHead = await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 3, baseRevision: null });
      expect(staleHead.status).toBe(409);
      expect(staleHead.body).toMatchObject({
        code: 'stale_revision',
        revision: 1,
      } satisfies Partial<StaleRevisionBody>);
      expect((await revisionsOf(doc.id)).map((r) => r.revision)).toEqual([1]);
    });

    it('still refuses a missing base', async () => {
      const doc = await createDraft('a');

      expect((await call('POST', `/documents/${doc.id}/revisions`, { draftVersion: 1 })).status).toBe(400);
    });
  });

  describe('the old PUT /documents/:id of an installed build', () => {
    it('keeps the draft it never saw as revision 1, then answers 409', async () => {
      const doc = await createDraft('écrit sur le web');
      // The build sees an empty text at revision 0 and saves something else.
      const saved = await call('PUT', `/documents/${doc.id}`, {
        title: 'Brouillon',
        content: 'écrit sur le téléphone',
        baseRevision: 0,
      });

      expect(saved.status).toBe(409);
      expect(saved.body).toMatchObject({ code: 'stale_revision', revision: 1 });
      expect(await get(doc.id)).toMatchObject({ revision: 1, content: 'écrit sur le web' });
      expect((await call('GET', `/documents/${doc.id}/revisions/1`)).body).toMatchObject({
        content: 'écrit sur le web',
      });
    });

    it('saves revision 1 when the draft is empty or already the saved text', async () => {
      const empty = await createDraft('');
      const fromEmpty = await call('PUT', `/documents/${empty.id}`, { title: 'B', content: 'texte', baseRevision: 0 });
      expect(fromEmpty.body).toMatchObject({ revision: 1, content: 'texte', draft: { baseRevision: 1 } });

      const same = await createDraft('texte');
      const fromSame = await call('PUT', `/documents/${same.id}`, { title: 'B', content: 'texte', baseRevision: 0 });
      expect(fromSame.body).toMatchObject({ revision: 1, content: 'texte', draft: { draftVersion: 1 } });
    });

    it('changes nothing when it sends back what it was shown', async () => {
      const doc = await createDraft('brouillon');
      const saved = await call('PUT', `/documents/${doc.id}`, { title: 'Brouillon', content: '', baseRevision: 0 });

      expect(saved).toEqual({ status: 200, body: doc });
      expect(await revisionsOf(doc.id)).toEqual([]);
    });
  });

  describe('creation sent again with the same id', () => {
    it('answers the same document, as it is now, and creates no second one', async () => {
      const input: CreateDraftDocumentInput = { id: randomUUID(), title: 'Composer', content: 'a', draftOnly: true };
      const first = await call('POST', '/documents', input);
      const again = await call('POST', '/documents', input);
      expect(again).toEqual(first);

      // The writer kept typing before the replay: the replay does not reset the draft.
      const draft = await call('PUT', `/documents/${input.id}/draft`, { content: 'ab', draftVersion: 1 });
      const replay = await call('POST', '/documents', input);
      expect(replay.status).toBe(201);
      expect((replay.body as Document).draft).toEqual(draft.body);

      const list = (await call('GET', '/documents')).body as DocumentSummary[];
      expect(list.filter((summary) => summary.id === input.id)).toHaveLength(1);
    });

    it('treats a blank title like no title, as the creation does', async () => {
      const id: string = randomUUID();
      await call('POST', '/documents', { id, title: '  ', content: 'a', draftOnly: true });

      expect((await call('POST', '/documents', { id, content: 'a', draftOnly: true })).status).toBe(201);
    });

    it('creates one revision only for a creation with a revision', async () => {
      const input = { id: randomUUID(), title: 'Ancien', content: 'v1' };
      await call('POST', '/documents', input);
      const again = await call('POST', '/documents', input);

      expect(again.body).toMatchObject({ id: input.id, revision: 1 });
      expect(await revisionsOf(input.id)).toHaveLength(1);
    });

    it('refuses the same id with another body, and changes nothing', async () => {
      const doc = await createDraft('a');
      const others = [
        { id: doc.id, title: 'Brouillon', content: 'b', draftOnly: true },
        { id: doc.id, title: 'Autre', content: 'a', draftOnly: true },
        { id: doc.id, title: 'Brouillon', content: 'a' },
      ];
      for (const other of others) {
        expect((await call('POST', '/documents', other)).status).toBe(422);
      }
      expect(await get(doc.id)).toEqual(doc);
    });

    it('answers 410 once the document was deleted, and does not bring it back', async () => {
      const input: CreateDraftDocumentInput = { id: randomUUID(), title: 'Supprimé', content: 'a', draftOnly: true };
      await call('POST', '/documents', input);
      await call('DELETE', `/documents/${input.id}`);

      expect((await call('POST', '/documents', input)).status).toBe(410);
      expect((await call('GET', `/documents/${input.id}`)).status).toBe(404);
    });

    it('refuses the id of a document created without one', async () => {
      const old = (await call('POST', '/documents', { title: 'Ancien', content: 'v1' })).body as Document;
      const reused = await call('POST', '/documents', { id: old.id, content: 'autre', draftOnly: true });

      expect(reused.status).toBe(422);
      expect(await get(old.id)).toEqual(old);
      // The refused creation left no record behind: the same request is refused again, not answered as a replay.
      expect((await call('POST', '/documents', { id: old.id, content: 'autre', draftOnly: true })).status).toBe(422);
    });
  });
});
