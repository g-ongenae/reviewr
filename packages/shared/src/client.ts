import type {
  ApiErrorBody,
  CreateDocumentInput,
  CreateDraftDocumentInput,
  CreateRevisionInput,
  Document,
  DocumentDraft,
  DocumentSummary,
  NameRevisionInput,
  RenameDocumentInput,
  Revision,
  RevisionSummary,
  SaveDraftInput,
  UpdateDocumentInput,
} from './types.js';
import { ApiError } from './api-error.js';
import { NetworkError } from './network-error.js';

const httpNoContent: number = 204;

/**
 * Path of a document resource.
 */
const documentPath = (id: string): string => `/documents/${encodeURIComponent(id)}`;

/**
 * Typed HTTP client for the Reviewr REST API.
 */
export class ReviewrClient {
  private readonly root: string;

  /**
   * @param baseUrl - Root URL of the API, e.g. `http://localhost:3000`
   * @param fetchFn - Fetch implementation, overridable for tests
   */
  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.root = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Check the API (and its database) is up.
   */
  public async health(): Promise<{ status: 'ok' }> {
    return this.request('GET', '/health');
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
   * A success means that the draft text of `draftVersion` is the head (`content`, `revision`). It does not mean
   * that this call created the revision, nor that `name` was applied: when the draft already was the head,
   * nothing is created and the name is ignored. Read the revision (`getRevision`, `listRevisions`) for its name.
   */
  public async createRevision(id: string, input: CreateRevisionInput): Promise<Document> {
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
   * Delete a document and its history.
   */
  public async deleteDocument(id: string): Promise<void> {
    return this.request('DELETE', documentPath(id));
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
   * Send a JSON request and parse the JSON response.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Headers = new Headers();
    headers.set('Accept', 'application/json');
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const response: Response = await this.fetchFn(`${this.root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((error: unknown) => {
      // An aborted request was cancelled on purpose: let the caller see it as such.
      throw error instanceof Error && error.name === 'AbortError' ? error : new NetworkError(error);
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
