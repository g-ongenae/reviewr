import type {
  ConflictBody,
  CreateRevisionInput,
  DeleteDocumentInput,
  Document,
  DocumentDraft,
  SaveDraftInput,
} from '@reviewr/shared';
import { ApiError } from '@reviewr/shared';
import type { DraftsApi } from './drafts';

/**
 * For tests: a server holding one document, with the draft and revision rules of the API, and controllable answers.
 */
export class FakeApi implements DraftsApi {
  document: Document;
  revisions: { revision: number; content: string; name?: string | null }[];
  /** Every request that reached the server, in order: `saveDraft <text>`, `createRevision <draft text>`… */
  log: string[] = [];
  /** Each draft text a save of this client replaced, and whether a revision held it at that moment. */
  overwritten: { text: string; kept: boolean }[] = [];
  /** While paused, requests wait for `release`. */
  paused = false;
  /** Every request fails with this error, if set. */
  failing: unknown;
  /** The document was deleted elsewhere. */
  gone = false;
  /** Drafts the server refuses as too large. */
  tooLarge = (content: string) => content.length > 20;
  /** How many of the next reads answer what the server held when they arrived, but only at `releaseReads`. */
  lateReads = 0;
  private waiting: (() => void)[] = [];
  private waitingReads: (() => void)[] = [];

  constructor(content: string) {
    const now = '2026-11-16T10:00:00.000Z';
    this.document = {
      id: 'doc',
      title: null,
      revision: 1,
      content,
      createdAt: now,
      updatedAt: now,
      draft: { content, draftVersion: 1, baseRevision: 1 },
    };
    this.revisions = [{ revision: 1, content }];
  }

  get draft(): DocumentDraft {
    return this.document.draft!;
  }

  /** The document as a read answers it. */
  read = (): Document => structuredClone(this.document);

  /** Another device saves a draft. */
  otherDevice(content: string) {
    this.document.draft = { ...this.draft, content, draftVersion: this.draft.draftVersion + 1 };
  }

  /** Another device makes a version of another text: the head moves, the draft does not. */
  otherVersion(content: string) {
    this.document.revision++;
    this.document.content = content;
    this.revisions.push({ revision: this.document.revision, content });
  }

  release() {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resume of waiting) resume();
  }

  async getDocument(): Promise<Document> {
    await this.gate('getDocument');
    const answer = this.read();
    // A late read: the server read the document now, its answer arrives at `releaseReads`.
    if (this.lateReads > 0) {
      this.lateReads--;
      await new Promise<void>((resume) => this.waitingReads.push(resume));
    }
    return answer;
  }

  releaseReads() {
    const waiting = this.waitingReads;
    this.waitingReads = [];
    for (const resume of waiting) resume();
  }

  async saveDraft(_id: string, { content, draftVersion }: SaveDraftInput): Promise<DocumentDraft> {
    await this.gate(`saveDraft ${content}`);
    if (this.tooLarge(content)) throw new ApiError(413, { statusCode: 413, message: 'The text is too large' });
    if (content === this.draft.content) return { ...this.draft };
    if (draftVersion !== this.draft.draftVersion) throw this.conflict({ code: 'draft_conflict', draft: this.draft });
    // This client overwrites the draft: was its text kept?
    const text = this.draft.content;
    this.overwritten.push({ text, kept: this.revisions.some((revision) => revision.content === text) });
    this.otherDevice(content);
    return { ...this.draft };
  }

  async createRevision(_id: string, { name, draftVersion, baseRevision }: CreateRevisionInput): Promise<Document> {
    await this.gate(`createRevision ${this.draft.content}`);
    if (draftVersion !== this.draft.draftVersion) throw this.conflict({ code: 'draft_conflict', draft: this.draft });
    if (this.draft.content === this.document.content) return this.read();
    if ((baseRevision ?? 0) !== this.document.revision) {
      throw this.conflict({ code: 'stale_revision', revision: this.document.revision });
    }
    this.otherVersion(this.draft.content);
    this.revisions[this.revisions.length - 1]!.name = name;
    this.document.draft = { ...this.draft, baseRevision: this.document.revision };
    return this.read();
  }

  async renameDocument(_id: string, title: string | null): Promise<Document> {
    await this.gate(`renameDocument ${title}`);
    this.document.title = title;
    return this.read();
  }

  /** Deletes the document, only if it is still as `seen` when given (`document_changed` otherwise). */
  async deleteDocument(_id: string, seen?: DeleteDocumentInput): Promise<void> {
    await this.gate(seen === undefined ? 'deleteDocument' : `deleteDocument ${seen.revision} ${seen.draftVersion}`);
    if (seen !== undefined && (seen.revision !== this.document.revision || seen.draftVersion !== this.draft.draftVersion)) {
      throw this.conflict({ code: 'document_changed', revision: this.document.revision, draft: this.draft });
    }
    this.gone = true;
  }

  private conflict(
    body:
      | { code: 'draft_conflict'; draft: DocumentDraft }
      | { code: 'stale_revision'; revision: number }
      | { code: 'document_changed'; revision: number; draft: DocumentDraft },
  ) {
    return new ApiError(409, { statusCode: 409, message: 'Conflict', ...structuredClone(body) } as ConflictBody);
  }

  private async gate(request: string) {
    if (this.paused) await new Promise<void>((resume) => this.waiting.push(resume));
    if (this.failing !== undefined) throw this.failing;
    if (this.gone) throw new ApiError(404, { statusCode: 404, message: 'Document not found' });
    this.log.push(request);
  }
}
