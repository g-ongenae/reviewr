import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/database/database.js';

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
const titledDocuments = [
  { id: '00000000-0000-4000-8000-000000000011', title: 'Chapitre 1', revisions: ['', 'Il était une fois'] },
  { id: '00000000-0000-4000-8000-000000000012', title: '', revisions: ['Écrit sans titre 🙂\r\nfin'] },
  { id: '00000000-0000-4000-8000-000000000013', title: ' \t\n', revisions: ['espaces', 'puis du texte'] },
  { id: '00000000-0000-4000-8000-000000000014', title: '  Titre entouré  ', revisions: [longText] },
];

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
      const content = doc.revisions[latest - 1];
      await pglite.query(
        `INSERT INTO documents (id, title, content, revision, draft_content, draft_base_revision)
         VALUES ($1, $2, $3, $4, $3, $4)`,
        [doc.id, doc.title, content, latest],
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

  it('turns blank document titles into NULL and keeps the others and the text', async () => {
    const { rows } = await pglite.query<{ id: string; title: string | null; content: string; draftContent: string }>(
      'SELECT id, title, content, draft_content AS "draftContent" FROM documents ORDER BY id',
    );

    expect(rows).toEqual(
      titledDocuments.map((doc) => ({
        id: doc.id,
        title: migratedTitle(doc.title),
        content: doc.revisions.at(-1),
        draftContent: doc.revisions.at(-1),
      })),
    );
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
