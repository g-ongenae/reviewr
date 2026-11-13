import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error.js';
import { ReviewrClient } from './client.js';
import { conflictOf } from './errors.js';
import type {
  ConflictBody,
  CreateRevisionInput,
  Document,
  DocumentDraft,
  DraftConflictBody,
  RevisionSummary,
} from './types.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const serverDraft: DocumentDraft = { content: 'phone', draftVersion: 3, baseRevision: 1 };

describe('ReviewrClient.saveDraft', () => {
  it('sends the draft to PUT /documents/:id/draft and returns the saved draft', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, serverDraft));
    const client: ReviewrClient = new ReviewrClient('http://api.test/', fetchFn);

    await expect(client.saveDraft('a/b', { content: 'phone', draftVersion: 2 })).resolves.toEqual(serverDraft);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/a%2Fb/draft',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ content: 'phone', draftVersion: 2 }) }),
    );
  });

  it('exposes the server draft of a conflict through conflictOf', async () => {
    const body: DraftConflictBody = {
      statusCode: 409,
      error: 'Conflict',
      message: 'Draft was modified elsewhere',
      code: 'draft_conflict',
      draft: serverDraft,
    };
    const client: ReviewrClient = new ReviewrClient(
      'http://api.test',
      vi.fn(async () => jsonResponse(409, body)),
    );

    const error: unknown = await client.saveDraft('id', { content: 'web', draftVersion: 2 }).catch((e: unknown) => e);
    const conflict: ConflictBody | undefined = conflictOf(error);
    expect(conflict?.code).toBe('draft_conflict');
    if (conflict?.code === 'draft_conflict') {
      expect(conflict.draft).toEqual(serverDraft);
    }
  });
});

describe('ReviewrClient.createRevision', () => {
  it('sends the version to POST /documents/:id/revisions and returns the document', async () => {
    const document: Document = {
      id: 'a/b',
      title: 'Chapitre',
      revision: 2,
      content: 'phone',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      draft: { content: 'phone', draftVersion: 3, baseRevision: 2 },
    };
    const fetchFn = vi.fn(async () => jsonResponse(200, document));
    const client: ReviewrClient = new ReviewrClient('http://api.test/', fetchFn);
    const input: CreateRevisionInput = { name: 'Relu', draftVersion: 3, baseRevision: 1 };

    await expect(client.createRevision('a/b', input)).resolves.toEqual(document);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/a%2Fb/revisions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    );
  });
});

describe('ReviewrClient.renameDocument', () => {
  it('sends the title to PATCH /documents/:id and returns the document', async () => {
    const document: Document = {
      id: 'a/b',
      title: 'Chapitre 2',
      revision: 1,
      content: 'texte',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    const fetchFn = vi.fn(async () => jsonResponse(200, document));
    const client: ReviewrClient = new ReviewrClient('http://api.test/', fetchFn);

    await expect(client.renameDocument('a/b', 'Chapitre 2')).resolves.toEqual(document);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/a%2Fb',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Chapitre 2' }) }),
    );
  });

  it('sends null to remove the title', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, {}));
    // eslint-disable-next-line no-null/no-null -- null makes the document untitled
    await new ReviewrClient('http://api.test', fetchFn).renameDocument('id', null);

    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/id',
      expect.objectContaining({ body: '{"title":null}' }),
    );
  });
});

describe('ReviewrClient.nameRevision', () => {
  it('sends the label to PATCH /documents/:id/revisions/:revision and returns the summary', async () => {
    const summary: RevisionSummary = {
      documentId: 'a/b',
      revision: 3,
      title: 'Chapitre',
      name: 'Relu',
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const fetchFn = vi.fn(async () => jsonResponse(200, summary));
    const client: ReviewrClient = new ReviewrClient('http://api.test/', fetchFn);

    await expect(client.nameRevision('a/b', 3, 'Relu')).resolves.toEqual(summary);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/a%2Fb/revisions/3',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Relu' }) }),
    );
  });

  it('rejects with the status of an unknown revision', async () => {
    const client: ReviewrClient = new ReviewrClient(
      'http://api.test',
      vi.fn(async () => jsonResponse(404, { statusCode: 404, message: 'Revision 9 of document id not found' })),
    );

    // eslint-disable-next-line no-null/no-null -- null clears the label
    await expect(client.nameRevision('id', 9, null)).rejects.toMatchObject({ status: 404 });
  });
});

describe('conflictOf', () => {
  const conflict409 = (body: object): ApiError => new ApiError(409, { statusCode: 409, message: 'Conflict', ...body });

  it('returns a well-formed stale_revision body', () => {
    expect(conflictOf(conflict409({ code: 'stale_revision', revision: 2 }))).toMatchObject({
      code: 'stale_revision',
      revision: 2,
    });
  });

  it('accepts a draft without a base revision', () => {
    // eslint-disable-next-line no-null/no-null -- the API sends JSON null
    const draft: DocumentDraft = { ...serverDraft, baseRevision: null };
    expect(conflictOf(conflict409({ code: 'draft_conflict', draft }))).toMatchObject({ draft });
  });

  it('ignores errors that are not structured 409s', () => {
    expect(conflictOf(new Error('boom'))).toBeUndefined();
    expect(conflictOf(new ApiError(409, { statusCode: 409, message: 'Conflict' }))).toBeUndefined();
    expect(conflictOf(new ApiError(409, undefined))).toBeUndefined();
    expect(conflictOf(conflict409({ code: 'unsaved_draft', draft: serverDraft }))).toBeUndefined();
    expect(
      conflictOf(
        new ApiError(400, { statusCode: 400, message: 'x', code: 'draft_conflict', draft: serverDraft } as never),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['no draft', { code: 'draft_conflict' }],
    // eslint-disable-next-line no-null/no-null -- a JSON null
    ['a null draft', { code: 'draft_conflict', draft: null }],
    ['a draft without content', { code: 'draft_conflict', draft: { draftVersion: 2, baseRevision: 1 } }],
    ['a non-integer draftVersion', { code: 'draft_conflict', draft: { ...serverDraft, draftVersion: '2' } }],
    ['a zero draftVersion', { code: 'draft_conflict', draft: { ...serverDraft, draftVersion: 0 } }],
    ['a missing baseRevision', { code: 'draft_conflict', draft: { content: 'x', draftVersion: 2 } }],
    ['a fractional baseRevision', { code: 'draft_conflict', draft: { ...serverDraft, baseRevision: 1.5 } }],
    ['no revision', { code: 'stale_revision' }],
    ['a string revision', { code: 'stale_revision', revision: '2' }],
  ])('rejects a known code with %s', (_case: string, body: object) => {
    expect(conflictOf(conflict409(body))).toBeUndefined();
  });
});
