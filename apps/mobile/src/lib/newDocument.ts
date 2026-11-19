import type { CreateDraftDocumentInput, Document } from '@reviewr/shared';
import { ApiError } from '@reviewr/shared';

/** 4xx statuses the server answers before it decided anything: the creation may still be sent again on its id. */
const retryableClientErrors = new Set([408, 425, 429]);

/**
 * Whether the creation was decided by the server: then its id is ended, and the next creation takes a new one. A 4xx
 * is decided (a 410 for an id whose document was deleted, a 422 for a refused body), and sending it again cannot help.
 * A network error or a 5xx is not: the document may exist without the phone knowing it, so the id is kept, and the
 * same creation sent again answers it.
 */
const decided = (error: unknown): boolean =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && !retryableClientErrors.has(error.status);

export interface NewDocumentOptions {
  api: { createDocument(input: CreateDraftDocumentInput): Promise<Document> };
  /** A new document id: a version 4 UUID from a real random source. */
  newId: () => string;
}

/**
 * Creates an empty document with no version, a draft only, under an id chosen here. A creation whose answer was lost
 * keeps its id: the next call sends the same creation again, so it answers the one document and never makes a second.
 * A call while a creation is under way waits for that one.
 */
export const createNewDocument = ({ api, newId }: NewDocumentOptions): (() => Promise<Document>) => {
  let pendingId: string | undefined;
  let inFlight: Promise<Document> | undefined;

  const send = async (): Promise<Document> => {
    const id = pendingId ?? newId();
    pendingId = id;
    try {
      const document = await api.createDocument({ id, content: '', draftOnly: true });
      pendingId = undefined;
      return document;
    } catch (error) {
      if (decided(error)) pendingId = undefined;
      throw error;
    }
  };

  return () => {
    inFlight ??= send().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
};
