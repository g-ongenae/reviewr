import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error.js';
import { ReviewrClient } from './client.js';
import { conflictOf, isServerUnreachable } from './errors.js';
import { NetworkError } from './network-error.js';
import type {
  ConflictBody,
  CreateDraftDocumentInput,
  CreateRevisionInput,
  Document,
  DocumentDraft,
  DraftConflictBody,
  RevisionSummary,
  SavedVersion,
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

  it('sends the idempotency key with the version and returns the revision saved', async () => {
    const saved: SavedVersion = {
      id: 'a',
      title: 'Chapitre',
      revision: 3,
      content: 'v3',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      draft: { content: 'v4', draftVersion: 5, baseRevision: 3 },
      savedRevision: 2,
    };
    const fetchFn = vi.fn(async () => jsonResponse(200, saved));
    const client: ReviewrClient = new ReviewrClient('http://api.test', fetchFn);
    const input: CreateRevisionInput = {
      draftVersion: 3,
      baseRevision: 1,
      idempotencyKey: '6f1c0f43-6f39-4b8a-9d3e-1f0a2b3c4d5e',
    };

    await expect(client.createRevision('a', input)).resolves.toEqual(saved);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/a/revisions',
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

describe('ReviewrClient.deleteDocument', () => {
  it('sends no precondition when none is given, as builds already installed do', async () => {
    const fetchFn = vi.fn(async () => new Response(undefined, { status: 204 }));
    const client: ReviewrClient = new ReviewrClient('http://api.test', fetchFn);

    await expect(client.deleteDocument('a/b')).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/a%2Fb',
      expect.objectContaining({ method: 'DELETE', body: undefined }),
    );
  });

  it('sends what it saw as query parameters', async () => {
    const fetchFn = vi.fn(async () => new Response(undefined, { status: 204 }));
    const client: ReviewrClient = new ReviewrClient('http://api.test', fetchFn);

    await client.deleteDocument('id', { revision: 0, draftVersion: 4 });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents/id?revision=0&draftVersion=4',
      expect.objectContaining({ method: 'DELETE', body: undefined }),
    );
  });

  it('exposes what the server holds now through conflictOf when the document moved', async () => {
    const body = {
      statusCode: 409,
      error: 'Conflict',
      message: 'moved',
      code: 'document_changed',
      revision: 2,
      draft: serverDraft,
    };
    const client: ReviewrClient = new ReviewrClient(
      'http://api.test',
      vi.fn(async () => jsonResponse(409, body)),
    );

    const error: unknown = await client.deleteDocument('id', { revision: 1, draftVersion: 2 }).catch((e: unknown) => e);
    expect(conflictOf(error)).toEqual(body);
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

  it('returns a well-formed document_changed body, also for a document without a revision', () => {
    const body = { code: 'document_changed', revision: 0, draft: serverDraft };
    expect(conflictOf(conflict409(body))).toMatchObject(body);
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
    ['a document_changed without draft', { code: 'document_changed', revision: 1 }],
    ['a document_changed without revision', { code: 'document_changed', draft: serverDraft }],
    ['a negative revision', { code: 'document_changed', revision: -1, draft: serverDraft }],
  ])('rejects a known code with %s', (_case: string, body: object) => {
    expect(conflictOf(conflict409(body))).toBeUndefined();
  });
});

describe('ReviewrClient.createDocument', () => {
  const document: Document = {
    id: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
    // eslint-disable-next-line no-null/no-null -- the API sends JSON null for an untitled document
    title: null,
    revision: 0,
    content: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    // eslint-disable-next-line no-null/no-null -- a draft without a revision has no base
    draft: { content: 'premier jet', draftVersion: 1, baseRevision: null },
  };

  it('sends a draft-only creation with its id to POST /documents, the same body every time', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, document));
    const client: ReviewrClient = new ReviewrClient('http://api.test', fetchFn);
    const input: CreateDraftDocumentInput = { id: document.id, content: 'premier jet', draftOnly: true };

    await expect(client.createDocument(input)).resolves.toEqual(document);
    await expect(client.createDocument(input)).resolves.toEqual(document);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchFn.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toBe('http://api.test/documents');
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
    }
  });

  it('still sends the body of a creation with a revision as it was', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, { ...document, revision: 1, content: 'v1' }));
    const client: ReviewrClient = new ReviewrClient('http://api.test', fetchFn);

    await client.createDocument({ title: 'Chapitre', content: 'v1' });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/documents',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'Chapitre', content: 'v1' }) }),
    );
  });

  it('rejects with the status of a reused id (422) or a deleted document (410)', async () => {
    for (const status of [422, 410]) {
      const client: ReviewrClient = new ReviewrClient(
        'http://api.test',
        vi.fn(async () => jsonResponse(status, { statusCode: status, message: 'refused' })),
      );
      const error: unknown = await client
        .createDocument({ id: document.id, content: 'autre', draftOnly: true })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(status);
    }
  });
});

describe('ReviewrClient time limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never answers, nor fails when its signal is aborted (the worst case). */
  const silentFetch = () =>
    vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>(() => {
          // Never settles.
        }),
    );

  /** Settles `promise` into a value or the error it rejected with, so fake time can run before it is awaited. */
  const settled = (promise: Promise<unknown>) => {
    const outcome: { done: boolean; value?: unknown; error?: unknown } = { done: false };
    void promise.then(
      (value: unknown) => Object.assign(outcome, { done: true, value }),
      (error: unknown) => Object.assign(outcome, { done: true, error }),
    );

    return outcome;
  };

  it('fails as unreachable after 15 s without an answer, and aborts the request', async () => {
    const fetchFn = silentFetch();
    const outcome = settled(new ReviewrClient('http://api.test', fetchFn).listDocuments());

    await vi.advanceTimersByTimeAsync(14_999);
    expect(outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error).toBeInstanceOf(NetworkError);
    expect(isServerUnreachable(outcome.error)).toBe(true);
    expect(((outcome.error as NetworkError).cause as Error).name).toBe('TimeoutError');
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports its own abort as unreachable, not as an abort', async () => {
    const aborted = vi.fn();
    const fetchFn = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted();
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const outcome = settled(new ReviewrClient('http://api.test', fetchFn, { timeoutMs: 1000 }).getDocument('id'));

    await vi.advanceTimersByTimeAsync(1000);
    expect(aborted).toHaveBeenCalledOnce();
    expect(isServerUnreachable(outcome.error)).toBe(true);
  });

  it('stays unreachable when the body fails after the limit', async () => {
    let fail: (error: Error) => void = () => undefined;
    const late = new ReadableStream<Uint8Array>({
      start: (controller) => {
        fail = (error) => controller.error(error);
      },
    });
    const fetchFn = vi.fn(async () => new Response(late, { status: 200 }));
    const outcome = settled(new ReviewrClient('http://api.test', fetchFn).getDocument('id'));

    await vi.advanceTimersByTimeAsync(15_000);
    fail(new TypeError('Connection reset'));
    await vi.advanceTimersByTimeAsync(0);
    expect(isServerUnreachable(outcome.error)).toBe(true);
    expect(((outcome.error as NetworkError).cause as Error).name).toBe('TimeoutError');
  });

  it('fails as unreachable when the body of the answer never finishes', async () => {
    const endless = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode('{"id":')),
    });
    const fetchFn = vi.fn(async () => new Response(endless, { status: 200 }));
    const outcome = settled(new ReviewrClient('http://api.test', fetchFn).getDocument('id'));

    await vi.advanceTimersByTimeAsync(15_000);
    expect(isServerUnreachable(outcome.error)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a request answered in time untouched, and no timer behind', async () => {
    const client = new ReviewrClient('http://api.test', vi.fn(async () => jsonResponse(200, serverDraft)));

    await expect(client.saveDraft('id', { content: 'phone', draftVersion: 2 })).resolves.toEqual(serverDraft);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets an abort of the caller through untouched, before the limit', async () => {
    // A fetch wrapper with its own controller, aborted on purpose after 10 s.
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      const own = new AbortController();
      setTimeout(() => own.abort(abort), 10_000);

      return new Promise<Response>((_resolve, reject) => {
        own.signal.addEventListener('abort', () => reject(own.signal.reason as Error));
      });
    });
    const outcome = settled(new ReviewrClient('http://api.test', fetchFn).listDocuments());

    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome.error).toBe(abort);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives the health check 5 s, and a long body one more second per 16 KiB', async () => {
    const client = new ReviewrClient('http://api.test', silentFetch());
    const health = settled(client.health());
    const save = settled(client.saveDraft('id', { content: 'a'.repeat(5 * 16_384), draftVersion: 1 }));

    await vi.advanceTimersByTimeAsync(5000);
    expect(isServerUnreachable(health.error)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(save.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(isServerUnreachable(save.error)).toBe(true);
  });
});
