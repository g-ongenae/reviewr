import type {
  ApiErrorBody,
  CreateDocumentInput,
  Document,
  DocumentDraft,
  DocumentSummary,
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
   * Create a document.
   */
  public async createDocument(input: CreateDocumentInput): Promise<Document> {
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
