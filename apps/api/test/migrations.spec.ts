import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { GoneException, UnprocessableEntityException } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/database/database.js';
import * as schema from '../src/database/schema.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import type { CreateDocumentBodyDto } from '../src/documents/dto/create-document-body.dto.js';
import { creationHash } from '../src/documents/idempotency.js';

interface Journal {
  entries: { tag: string }[];
}

/**
 * Copy the migrations folder, keeping only the first `count` migrations of the journal.
 */
const migrationsUpTo = async (count: number): Promise<string> => {
  const folder: string = await mkdtemp(join(tmpdir(), 'reviewr-migrations-'));
  await cp(migrationsFolder, folder, { recursive: true });
  const journalPath: string = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
  await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }));

  return folder;
};

// Texts as written before the draft columns existed: accents, typographic spaces, emoji, CRLF, empty, long.
const longText: string = 'Une phrase assez longue pour peser un peu. '.repeat(2_000);
const oldDocuments = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Chapitre 1',
    revisions: ['Il était une fois', 'Il était une fois : « un roi »\r\n— dit-elle 🙂'],
  },
  { id: '00000000-0000-4000-8000-000000000002', title: 'Vide', revisions: [''] },
  { id: '00000000-0000-4000-8000-000000000003', title: 'Long', revisions: ['court', 'moyen', longText] },
];

describe('Migration 0001 (draft columns) on a populated database', () => {
  let pglite: PGlite;
  let oldFolder: string;

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite);
    oldFolder = await migrationsUpTo(1);
    await migrate(db, { migrationsFolder: oldFolder });

    // Rows as the code before this migration wrote them: the document mirrors its latest revision.
    for (const doc of oldDocuments) {
      const latest = doc.revisions.length;
      await pglite.query('INSERT INTO documents (id, title, content, revision) VALUES ($1, $2, $3, $4)', [
        doc.id,
        doc.title,
        doc.revisions[latest - 1],
        latest,
      ]);
      for (const [index, content] of doc.revisions.entries()) {
        await pglite.query('INSERT INTO revisions (document_id, revision, title, content) VALUES ($1, $2, $3, $4)', [
          doc.id,
          index + 1,
          doc.title,
          content,
        ]);
      }
    }

    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pglite.close();
    await rm(oldFolder, { recursive: true, force: true });
  });

  it('backfills the draft from the current content and revision', async () => {
    const { rows } = await pglite.query<{
      id: string;
      title: string;
      content: string;
      revision: number;
      draftContent: string;
      draftVersion: number;
      draftBaseRevision: number;
    }>(
      `SELECT id, title, content, revision, draft_content AS "draftContent", draft_version AS "draftVersion",
        draft_base_revision AS "draftBaseRevision" FROM documents ORDER BY id`,
    );

    expect(rows).toEqual(
      oldDocuments.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.revisions.at(-1),
        revision: doc.revisions.length,
        draftContent: doc.revisions.at(-1),
        draftVersion: 1,
        draftBaseRevision: doc.revisions.length,
      })),
    );
  });

  it('keeps every revision and leaves them unnamed', async () => {
    const { rows } = await pglite.query<{
      documentId: string;
      revision: number;
      content: string;
      unnamed: boolean;
    }>(
      'SELECT document_id AS "documentId", revision, content, name IS NULL AS unnamed FROM revisions ORDER BY document_id, revision',
    );

    expect(rows).toEqual(
      oldDocuments.flatMap((doc) =>
        doc.revisions.map((content, index) => ({ documentId: doc.id, revision: index + 1, content, unnamed: true })),
      ),
    );
  });

  it('makes the draft text and version required', async () => {
    const { rows } = await pglite.query<{ column: string; nullable: string }>(
      `SELECT column_name AS column, is_nullable AS nullable FROM information_schema.columns
       WHERE table_name = 'documents' AND column_name LIKE 'draft_%' ORDER BY column_name`,
    );

    expect(rows).toEqual([
      { column: 'draft_base_revision', nullable: 'YES' },
      { column: 'draft_content', nullable: 'NO' },
      { column: 'draft_version', nullable: 'NO' },
    ]);
  });
});

// Documents as written before titles could be absent: the web Composer sent '' for the title.
// Two of them hold an autosaved draft ahead of their latest revision, which the migration must keep as it is.
interface TitledDocument {
  id: string;
  title: string;
  revisions: string[];
  draft?: { content: string; version: number; baseRevision: number };
}
const titledDocuments: TitledDocument[] = [
  { id: '00000000-0000-4000-8000-000000000011', title: 'Chapitre 1', revisions: ['', 'Il était une fois'] },
  {
    id: '00000000-0000-4000-8000-000000000012',
    title: '',
    revisions: ['Écrit sans titre 🙂\r\nfin'],
    draft: { content: 'Écrit sans titre 🙂\r\nfin, puis la suite pas encore enregistrée', version: 7, baseRevision: 1 },
  },
  { id: '00000000-0000-4000-8000-000000000013', title: ' \t\n', revisions: ['espaces', 'puis du texte'] },
  {
    id: '00000000-0000-4000-8000-000000000014',
    title: '  Titre entouré  ',
    revisions: ['court', longText],
    // Started from the first revision, before the second one was saved elsewhere.
    draft: { content: `${longText}…`, version: 3, baseRevision: 1 },
  },
];

/** Draft as stored: the one seeded, or the latest revision when nothing is pending. */
const draftOf = (doc: TitledDocument): { content: string; version: number; baseRevision: number } =>
  doc.draft ?? { content: doc.revisions.at(-1) ?? '', version: 1, baseRevision: doc.revisions.length };

/** Title as the migration should leave it: blank titles become NULL, others are kept as they are. */
// eslint-disable-next-line no-null/no-null -- NULL is what the migration writes for a blank title
const migratedTitle = (title: string): string | null => (title.trim().length > 0 ? title : null);

describe('Migration 0002 (nullable title) on a populated database', () => {
  let pglite: PGlite;
  let oldFolder: string;

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite);
    oldFolder = await migrationsUpTo(2);
    await migrate(db, { migrationsFolder: oldFolder });

    // Rows as the code before this migration wrote them, revisions included: a title-only change
    // made a revision with the old title, so the revisions of document 11 had no title at first.
    for (const doc of titledDocuments) {
      const latest = doc.revisions.length;
      const draft = draftOf(doc);
      await pglite.query(
        `INSERT INTO documents (id, title, content, revision, draft_content, draft_version, draft_base_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [doc.id, doc.title, doc.revisions[latest - 1], latest, draft.content, draft.version, draft.baseRevision],
      );
      for (const [index, revisionContent] of doc.revisions.entries()) {
        await pglite.query('INSERT INTO revisions (document_id, revision, title, content) VALUES ($1, $2, $3, $4)', [
          doc.id,
          index + 1,
          index === 0 && doc.title === 'Chapitre 1' ? '' : doc.title,
          revisionContent,
        ]);
      }
    }

    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pglite.close();
    await rm(oldFolder, { recursive: true, force: true });
  });

  it('turns blank document titles into NULL and keeps the others, the text and the drafts', async () => {
    const { rows } = await pglite.query<{
      id: string;
      title: string | null;
      content: string;
      revision: number;
      draftContent: string;
      draftVersion: number;
      draftBaseRevision: number;
    }>(
      `SELECT id, title, content, revision, draft_content AS "draftContent", draft_version AS "draftVersion",
        draft_base_revision AS "draftBaseRevision" FROM documents ORDER BY id`,
    );

    expect(rows).toEqual(
      titledDocuments.map((doc) => ({
        id: doc.id,
        title: migratedTitle(doc.title),
        content: doc.revisions.at(-1),
        revision: doc.revisions.length,
        draftContent: draftOf(doc).content,
        draftVersion: draftOf(doc).version,
        draftBaseRevision: draftOf(doc).baseRevision,
      })),
    );
    // The seeded drafts really differ from the saved text, so a lost draft would show.
    expect(rows.filter((row) => row.draftContent !== row.content).map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000014',
    ]);
  });

  it('does the same for the title of every revision', async () => {
    const { rows } = await pglite.query<{
      documentId: string;
      revision: number;
      title: string | null;
      content: string;
    }>('SELECT document_id AS "documentId", revision, title, content FROM revisions ORDER BY document_id, revision');

    expect(rows).toEqual(
      titledDocuments.flatMap((doc) =>
        doc.revisions.map((content, index) => ({
          documentId: doc.id,
          revision: index + 1,
          title: index === 0 && doc.title === 'Chapitre 1' ? migratedTitle('') : migratedTitle(doc.title),
          content,
        })),
      ),
    );
  });

  it('makes both titles nullable', async () => {
    const { rows } = await pglite.query<{ table: string; nullable: string }>(
      `SELECT table_name AS table, is_nullable AS nullable FROM information_schema.columns
       WHERE column_name = 'title' ORDER BY table_name`,
    );

    expect(rows).toEqual([
      { table: 'documents', nullable: 'YES' },
      { table: 'revisions', nullable: 'YES' },
    ]);
  });
});

describe('Migration 0003 (document creations) on a populated database', () => {
  let pglite: PGlite;
  let oldFolder: string;
  let targetFolder: string;
  const columns: string = `id, title, content, revision, draft_content AS "draftContent", draft_version AS "draftVersion",
    draft_base_revision AS "draftBaseRevision", created_at AS "createdAt", updated_at AS "updatedAt"`;
  let before: unknown[];
  let revisionsBefore: unknown[];

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite);
    oldFolder = await migrationsUpTo(3);
    await migrate(db, { migrationsFolder: oldFolder });

    // Rows as the code before this migration wrote them, one of them untitled with a draft ahead of its head.
    for (const doc of titledDocuments) {
      const latest = doc.revisions.length;
      const draft = draftOf(doc);
      await pglite.query(
        `INSERT INTO documents (id, title, content, revision, draft_content, draft_version, draft_base_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          doc.id,
          migratedTitle(doc.title),
          doc.revisions[latest - 1],
          latest,
          draft.content,
          draft.version,
          draft.baseRevision,
        ],
      );
      for (const [index, content] of doc.revisions.entries()) {
        await pglite.query('INSERT INTO revisions (document_id, revision, content) VALUES ($1, $2, $3)', [
          doc.id,
          index + 1,
          content,
        ]);
      }
    }
    before = (await pglite.query(`SELECT ${columns} FROM documents ORDER BY id`)).rows;
    revisionsBefore = (await pglite.query('SELECT * FROM revisions ORDER BY document_id, revision')).rows;

    targetFolder = await migrationsUpTo(4);
    await migrate(db, { migrationsFolder: targetFolder });
  });

  afterAll(async () => {
    await pglite.close();
    await rm(oldFolder, { recursive: true, force: true });
    await rm(targetFolder, { recursive: true, force: true });
  });

  it('leaves the documents, their drafts and their revisions as they were', async () => {
    expect(before).toHaveLength(titledDocuments.length);
    expect((await pglite.query(`SELECT ${columns} FROM documents ORDER BY id`)).rows).toEqual(before);
    expect((await pglite.query('SELECT * FROM revisions ORDER BY document_id, revision')).rows).toEqual(
      revisionsBefore,
    );
  });

  it('adds an empty table of creations, keyed by document id and with no foreign key', async () => {
    expect((await pglite.query('SELECT * FROM document_creations')).rows).toEqual([]);
    const { rows } = await pglite.query<{ type: string }>(
      `SELECT constraint_type AS type FROM information_schema.table_constraints
       WHERE table_name = 'document_creations' AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`,
    );
    expect(rows).toEqual([{ type: 'PRIMARY KEY' }]);
  });
});

describe('Migration 0004 (revision requests) on a populated database', () => {
  let pglite: PGlite;
  let oldFolder: string;
  const columns: string = `id, title, content, revision, draft_content AS "draftContent", draft_version AS "draftVersion",
    draft_base_revision AS "draftBaseRevision", created_at AS "createdAt", updated_at AS "updatedAt"`;
  let before: unknown[];
  let revisionsBefore: unknown[];

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite);
    oldFolder = await migrationsUpTo(4);
    await migrate(db, { migrationsFolder: oldFolder });

    // Rows as the code before this migration wrote them, one of them untitled with a draft ahead of its head.
    for (const doc of titledDocuments) {
      const latest = doc.revisions.length;
      const draft = draftOf(doc);
      await pglite.query(
        `INSERT INTO documents (id, title, content, revision, draft_content, draft_version, draft_base_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          doc.id,
          migratedTitle(doc.title),
          doc.revisions[latest - 1],
          latest,
          draft.content,
          draft.version,
          draft.baseRevision,
        ],
      );
      for (const [index, content] of doc.revisions.entries()) {
        await pglite.query('INSERT INTO revisions (document_id, revision, content) VALUES ($1, $2, $3)', [
          doc.id,
          index + 1,
          content,
        ]);
      }
    }
    before = (await pglite.query(`SELECT ${columns} FROM documents ORDER BY id`)).rows;
    revisionsBefore = (await pglite.query('SELECT * FROM revisions ORDER BY document_id, revision')).rows;

    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pglite.close();
    await rm(oldFolder, { recursive: true, force: true });
  });

  it('leaves the documents, their drafts and their revisions as they were', async () => {
    expect(before).toHaveLength(titledDocuments.length);
    expect((await pglite.query(`SELECT ${columns} FROM documents ORDER BY id`)).rows).toEqual(before);
    expect((await pglite.query('SELECT * FROM revisions ORDER BY document_id, revision')).rows).toEqual(
      revisionsBefore,
    );
  });

  it('adds an empty table of version requests, keyed by idempotency key, tied to the revisions', async () => {
    expect((await pglite.query('SELECT * FROM revision_requests')).rows).toEqual([]);
    const { rows } = await pglite.query<{ type: string }>(
      `SELECT constraint_type AS type FROM information_schema.table_constraints
       WHERE table_name = 'revision_requests' AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
       ORDER BY constraint_type`,
    );
    expect(rows).toEqual([{ type: 'FOREIGN KEY' }, { type: 'PRIMARY KEY' }]);
  });

  it('deletes the records of a document with it', async () => {
    const [doc] = titledDocuments;
    await pglite.query(
      `INSERT INTO revision_requests (idempotency_key, document_id, revision, request_hash)
       VALUES ('6f1c0f43-6f39-4b8a-9d3e-1f0a2b3c4d5e', $1, 1, 'hash')`,
      [doc?.id],
    );
    await pglite.query('DELETE FROM documents WHERE id = $1', [doc?.id]);
    expect((await pglite.query('SELECT * FROM revision_requests')).rows).toEqual([]);
  });

  it('refuses a record without its revision', async () => {
    await expect(
      pglite.query(
        `INSERT INTO revision_requests (idempotency_key, document_id, revision, request_hash)
         VALUES ('7f1c0f43-6f39-4b8a-9d3e-1f0a2b3c4d5e', $1, 99, 'hash')`,
        [titledDocuments[1]?.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('Migration 0005 (document ids never reused) on a populated database', () => {
  it('backfills legacy IDs without changing texts or existing creation records', async () => {
    const pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    const oldFolder = await migrationsUpTo(5);
    const legacyId: string = '00000000-0000-4000-8000-000000000020';
    const creation: CreateDocumentBodyDto = {
      id: '00000000-0000-4000-8000-000000000021',
      title: 'Brouillon',
      content: 'Sur la page blanche 🙂',
      draftOnly: true,
    };
    const deletedId: string = '00000000-0000-4000-8000-000000000022';
    const hash: string = creationHash(creation);

    try {
      await migrate(db, { migrationsFolder: oldFolder });
      await pglite.query(
        `INSERT INTO documents (id, title, content, revision, draft_content, draft_version, draft_base_revision)
         VALUES ($1, 'Ancien', 'Écrit hier', 1, 'Écrit aujourd’hui', 2, 1), ($2, $3, '', 0, $4, 1, NULL)`,
        [legacyId, creation.id, creation.title, creation.content],
      );
      await pglite.query('INSERT INTO revisions (document_id, revision, content) VALUES ($1, 1, $2)', [
        legacyId,
        'Écrit hier',
      ]);
      await pglite.query('INSERT INTO document_creations (document_id, request_hash) VALUES ($1, $3), ($2, $3)', [
        creation.id,
        deletedId,
        hash,
      ]);
      const documentsBefore = await pglite.query('SELECT * FROM documents ORDER BY id');
      const revisionsBefore = await pglite.query('SELECT * FROM revisions');

      await migrate(db, { migrationsFolder });
      expect((await pglite.query('SELECT * FROM documents ORDER BY id')).rows).toEqual(documentsBefore.rows);
      expect((await pglite.query('SELECT * FROM revisions')).rows).toEqual(revisionsBefore.rows);
      const { rows } = await pglite.query(
        `SELECT c.document_id AS "documentId", c.request_hash AS "requestHash", c.created_at = d.created_at AS "sameCreatedAt"
         FROM document_creations c JOIN documents d ON d.id = c.document_id WHERE c.document_id = $1`,
        [legacyId],
      );
      // eslint-disable-next-line no-null/no-null -- server-chosen IDs have no request hash
      expect(rows).toEqual([{ documentId: legacyId, requestHash: null, sameCreatedAt: true }]);

      const service = new DocumentsService(db);
      await expect(service.create(creation)).resolves.toMatchObject({
        revision: 0,
        draft: { content: creation.content },
      });
      await expect(service.create({ ...creation, id: deletedId })).rejects.toThrow(GoneException);
      const reuse = { ...creation, id: legacyId };
      await expect(service.create(reuse)).rejects.toThrow(UnprocessableEntityException);
      await service.delete(legacyId);
      await expect(service.create(reuse)).rejects.toThrow(GoneException);
    } finally {
      await pglite.close();
      await rm(oldFolder, { recursive: true, force: true });
    }
  });
});
