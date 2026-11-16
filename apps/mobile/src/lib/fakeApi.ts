import type { ConflictBody, CreateRevisionInput, Document, DocumentDraft, SaveDraftInput } from '@reviewr/shared';
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
  private waiting: (() => void)[] = [];

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
    return this.read();
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

  private conflict(
    body: { code: 'draft_conflict'; draft: DocumentDraft } | { code: 'stale_revision'; revision: number },
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
