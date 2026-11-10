import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error.js';
import { ReviewrClient } from './client.js';
import { conflictOf } from './errors.js';
import type { ConflictBody, DocumentDraft, DraftConflictBody } from './types.js';

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
