import type {
  ApiErrorBody,
  CreateDocumentInput,
  CreateDraftDocumentInput,
  CreateRevisionInput,
  DeleteDocumentInput,
  Document,
  DocumentDraft,
  DocumentSummary,
  NameRevisionInput,
  RenameDocumentInput,
  Revision,
  RevisionSummary,
  SaveDraftInput,
  SavedVersion,
  UpdateDocumentInput,
} from './types.js';
import { ApiError } from './api-error.js';
import { NetworkError } from './network-error.js';

const httpNoContent: number = 204;

/** Default limit for a request to end, answer included: see {@link ClientOptions.timeoutMs}. */
const defaultTimeoutMs: number = 30_000;

/** Default limit for the health check: see {@link ClientOptions.healthTimeoutMs}. */
const defaultHealthTimeoutMs: number = 5000;

/** Characters of request body sent per second of time added to the limit (about 128 kbit/s, up and back). */
const bodyCharsPerSecond: number = 16_384;

const msPerSecond: number = 1000;

/**
 * Time limits of the client. A request that has no complete answer (headers and body) in time is aborted and rejects
 * with a `NetworkError`, as when the server cannot be reached.
 */
export interface ClientOptions {
  /**
   * Limit of a request, in milliseconds, plus one second per 16 KiB of body it sends (a draft can be long, and is
   * answered with its text). Default: 30 s, for a home server reached through a VPN from a slow mobile network.
   */
  timeoutMs?: number;
  /** Limit of the health check, in milliseconds. Default: 5 s, the interval at which the apps poll it. */
  healthTimeoutMs?: number;
}

/**
 * Path of a document resource.
 */
const documentPath = (id: string): string => `/documents/${encodeURIComponent(id)}`;

/**
 * Typed HTTP client for the Reviewr REST API.
 */
export class ReviewrClient {
  private readonly root: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;

  /**
   * @param baseUrl - Root URL of the API, e.g. `http://localhost:3000`
   * @param fetchFn - Fetch implementation, overridable for tests
   * @param options - Time limits of the requests
   */
  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
    options: ClientOptions = {},
  ) {
    this.root = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.healthTimeoutMs = options.healthTimeoutMs ?? defaultHealthTimeoutMs;
  }

  /**
   * Check the API (and its database) is up.
   */
  public async health(): Promise<{ status: 'ok' }> {
    return this.request('GET', '/health', undefined, this.healthTimeoutMs);
  }

  /**
   * List documents, most recently updated first.
   */
  public async listDocuments(): Promise<DocumentSummary[]> {
    return this.request('GET', '/documents');
  }

  /**
   * Get a document with its current content.
   */
  public async getDocument(id: string): Promise<Document> {
    return this.request('GET', documentPath(id));
  }

  /**
   * Create a document. With `{ title, content }`, the content is its first revision and the draft starts equal to
   * it. With a `CreateDraftDocumentInput`, it has only a draft, and the call can be sent again with the same body
   * (it answers the same document): it rejects with a 422 `ApiError` if the `id` was used with another body, and
   * a 410 if that document was deleted since.
   */
  public async createDocument(input: CreateDocumentInput | CreateDraftDocumentInput): Promise<Document> {
    return this.request('POST', '/documents', input);
  }

  /**
   * Save a new version of a document. Rejects with a 409 `ApiError` if it was saved elsewhere since `baseRevision`.
   */
  public async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    return this.request('PUT', documentPath(id), input);
  }

  /**
   * Autosave the draft of a document; creates no revision. Rejects with a 409 `ApiError` whose body is a
   * `DraftConflictBody` (read it with `conflictOf`) if the draft was saved elsewhere since `draftVersion`.
   */
  public async saveDraft(id: string, input: SaveDraftInput): Promise<DocumentDraft> {
    return this.request('PUT', `${documentPath(id)}/draft`, input);
  }

  /**
   * Save the server's draft as a new version (revision) and answer the document. Rejects with a 409 `ApiError`
   * (read it with `conflictOf`): `draft_conflict` if the draft moved since `draftVersion`; otherwise
   * `stale_revision` if the head moved since `baseRevision`, unless the draft already is the head.
   *
   * A success without a key, or the first success with one, means that the draft text of `draftVersion` is the head
   * (`content`, `revision`). It does not mean
   * that this call created the revision, nor that `name` was applied: when the draft already was the head,
   * nothing is created and the name is ignored. Read the revision (`getRevision`, `listRevisions`) for its name.
   *
   * With an `idempotencyKey`, the same call can be sent again after a lost answer: once the first one succeeded, it
   * answers success with the revision saved (`savedRevision`) whatever happened to the draft and the head since, and
   * creates nothing: the head may then be a later revision, and `savedRevision` is the one holding the text sent.
   * The same key with another input rejects with a 422 `ApiError`. One exception: an empty draft on a document
   * without a revision saves nothing (`savedRevision` null) and records no key, so sending it again is decided again.
   */
  public async createRevision(id: string, input: CreateRevisionInput): Promise<SavedVersion> {
    return this.request('POST', `${documentPath(id)}/revisions`, input);
  }

  /**
   * Rename a document (null or blank: untitled). Creates no revision and leaves the content and the draft alone.
   */
  public async renameDocument(id: string, title: string | null): Promise<Document> {
    const input: RenameDocumentInput = { title };

    return this.request('PATCH', documentPath(id), input);
  }

  /**
   * Set the label of a saved version, or clear it with null or a blank name. Answers the revision's summary.
   */
  public async nameRevision(documentId: string, revision: number, name: string | null): Promise<RevisionSummary> {
    const input: NameRevisionInput = { name };

    return this.request('PATCH', `${documentPath(documentId)}/revisions/${revision}`, input);
  }

  /**
   * Delete a document and its history. With `seen` (the head revision and `draftVersion` last read), the document is
   * deleted only if neither moved since: otherwise nothing is deleted and the call rejects with a 409 `ApiError`
   * whose body is a `DocumentChangedBody` (read it with `conflictOf`), holding what the server has now.
   */
  public async deleteDocument(id: string, seen?: DeleteDocumentInput): Promise<void> {
    const query: string =
      seen === undefined
        ? ''
        : `?${new URLSearchParams({ revision: String(seen.revision), draftVersion: String(seen.draftVersion) }).toString()}`;

    return this.request('DELETE', `${documentPath(id)}${query}`);
  }

  /**
   * List the revisions of a document, newest first.
   */
  public async listRevisions(documentId: string): Promise<RevisionSummary[]> {
    return this.request('GET', `${documentPath(documentId)}/revisions`);
  }

  /**
   * Get a single revision of a document.
   */
  public async getRevision(documentId: string, revision: number): Promise<Revision> {
    return this.request('GET', `${documentPath(documentId)}/revisions/${revision}`);
  }

  /**
   * Send a JSON request and parse the JSON response, within a time limit (by default, the client's limit for the body
   * sent). A request still unanswered then is aborted and rejects with a `NetworkError`. The timer is a race, not only
   * an abort, so the request ends even with a fetch that ignores the signal or a body that never finishes.
   */
  private async request<T>(method: string, path: string, body?: unknown, limitMs?: number): Promise<T> {
    const payload: string | undefined = body === undefined ? undefined : JSON.stringify(body);
    const limit: number =
      limitMs ?? this.timeoutMs + Math.ceil((payload?.length ?? 0) / bodyCharsPerSecond) * msPerSecond;
    const controller: AbortController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut: Promise<never> = new Promise<never>((unused: unknown, reject: (error: NetworkError) => void) => {
      timer = setTimeout(() => {
        const cause: Error = new Error(`No complete answer within ${limit} ms`);
        cause.name = 'TimeoutError';
        reject(new NetworkError(cause));
        controller.abort(cause);
      }, limit);
    });

    return Promise.race([this.send<T>(method, path, payload, controller.signal), timedOut]).finally(() => {
      clearTimeout(timer);
    });
  }

  /**
   * Send a request and read its answer; `signal` is aborted only by the time limit of `request`.
   */
  private async send<T>(method: string, path: string, payload: string | undefined, signal: AbortSignal): Promise<T> {
    const headers: Headers = new Headers();
    headers.set('Accept', 'application/json');
    if (payload !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const response: Response = await this.fetchFn(`${this.root}${path}`, {
      method,
      headers,
      body: payload,
      signal,
    }).catch((error: unknown) => {
      // An abort of the caller's was made on purpose: let the caller see it as such. One of the time limit is a failure.
      throw error instanceof Error && error.name === 'AbortError' && !signal.aborted ? error : new NetworkError(error);
    });

    if (!response.ok) {
      const errorBody: ApiErrorBody | undefined = await response.json().then(
        (json: unknown) => json as ApiErrorBody,
        () => undefined,
      );
      throw new ApiError(response.status, errorBody);
    }

    if (response.status === httpNoContent) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}
