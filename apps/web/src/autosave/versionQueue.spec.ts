import type { CreateRevisionInput, Document } from '@reviewr/shared';
import { ApiError } from '@reviewr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, type Autosave, type Draft, type SaveResult } from './autosave';
import { toSaveResult } from './useAutosave';
import { createVersionQueue, holdOnStop, type VersionQueue } from './versionQueue';

/** An error of the API with its body, as the client throws it (a 409 body carries more than `ApiErrorBody`). */
const apiError = (status: number, body: Record<string, unknown> = {}) =>
  new ApiError(status, { statusCode: status, message: 'Refused', ...body });

/**
 * A server with the API's rules for the draft and the revisions: a draft already holding the text sent is answered as
 * saved, a stale counter is a conflict, a draft equal to the head makes no revision. Requests can be held (answered
 * later, with the server's state at that time) or failed.
 */
const fakeServer = () => {
  let draft: Draft = { content: 'Once', draftVersion: 1 };
  let head = { revision: 1, content: 'Once' };
  const revisions: { revision: number; content: string; name: string | null }[] = [];
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  /** Answers instead of the server while it returns something. */
  let fail: (call: string) => SaveResult | Error | undefined = () => undefined;
  /** Requests the server runs, whose answer is lost on the way back. */
  let lose: (call: string) => boolean = () => false;
  const held: (() => void)[] = [];
  let holding = false;

  const answer = <T>(call: string, run: () => T): Promise<T> => {
    calls.push(call);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        inFlight--;
        const failure = fail(call);
        if (failure instanceof Error) reject(failure);
        else if (failure !== undefined) reject(new Error(`unexpected ${failure.kind}`));
        else {
          try {
            const result = run();
            if (lose(call)) reject(new TypeError('Failed to fetch'));
            else resolve(result);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      };
      if (holding) held.push(go);
      else go();
    });
  };

  const conflict = () =>
    apiError(409, {
      code: 'draft_conflict',
      draft: { ...draft, baseRevision: head.revision },
    });

  const document = (): Document => ({
    id: 'doc-1',
    title: null,
    revision: head.revision,
    content: head.content,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    draft: { ...draft, baseRevision: head.revision },
  });

  /** The machine's raw `save`: `PUT /documents/:id/draft`. */
  const saveDraft = async (sent: Draft): Promise<SaveResult> => {
    try {
      const saved = await answer(`PUT ${sent.content}@${sent.draftVersion}`, () => {
        if (draft.content === sent.content) return draft;
        if (draft.draftVersion !== sent.draftVersion) throw conflict();
        draft = { content: sent.content, draftVersion: draft.draftVersion + 1 };
        return draft;
      });
      return { kind: 'saved', draftVersion: saved.draftVersion };
    } catch (error) {
      return toSaveResult(error);
    }
  };

  const createRevision = (input: CreateRevisionInput) =>
    answer(`POST @${input.draftVersion}${input.name === undefined ? '' : ` ${input.name}`}`, () => {
      if (draft.draftVersion !== input.draftVersion) throw conflict();
      if (draft.content === head.content) return document();
      if (head.revision !== (input.baseRevision ?? 0)) {
        throw apiError(409, {
          code: 'stale_revision',
          revision: head.revision,
        });
      }
      head = { revision: head.revision + 1, content: draft.content };
      revisions.push({ revision: head.revision, content: draft.content, name: input.name ?? null });
      return document();
    });

  const nameRevision = (revision: number, name: string) =>
    answer(`PATCH ${revision} ${name}`, () => {
      const named = revisions.find((item) => item.revision === revision);
      if (named === undefined) throw apiError(404);
      named.name = name;
      return named;
    });

  return {
    saveDraft,
    createRevision,
    nameRevision,
    calls,
    revisions,
    draft: () => draft,
    head: () => head,
    maxInFlight: () => maxInFlight,
    /** Another device saves a draft. */
    otherDraft: (content: string) => {
      draft = { content, draftVersion: draft.draftVersion + 1 };
    },
    /** Another device saves a version of the draft it holds. */
    otherVersion: () => {
      head = { revision: head.revision + 1, content: draft.content };
      revisions.push({ revision: head.revision, content: draft.content, name: 'Theirs' });
    },
    setLose: (next: typeof lose) => {
      lose = next;
    },
    setFail: (next: typeof fail) => {
      fail = next;
    },
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      for (const go of held.splice(0)) go();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
};

const unreachable = () => new TypeError('Failed to fetch');

describe('createVersionQueue', () => {
  let server: ReturnType<typeof fakeServer>;
  let queue: VersionQueue;
  let autosave: Autosave;
  let headSeen: number;

  /** The editor's "Save version": the text and its name are queued at the click, then the machine saves now. */
  const saveVersion = (text: string, name?: string) => {
    queue.enqueue({ text, name });
    return autosave.flush();
  };
  /** A read of the document: the machine is told about the server's draft. */
  const read = () => autosave.refresh(server.draft());

  const versions = () => server.revisions.map(({ content, name }) => [name, content]);
  const offline = () => server.setFail(unreachable);
  const online = () => server.setFail(() => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    server = fakeServer();
    headSeen = 1;
    queue = createVersionQueue({
      createRevision: server.createRevision,
      nameRevision: server.nameRevision,
      head: () => headSeen,
      toSaveResult,
      onRevision: (document) => {
        headSeen = document.revision;
      },
    });
    autosave = createAutosave({
      base: { content: 'Once', draftVersion: 1 },
      save: (draft) => queue.send(draft, server.saveDraft),
      mustSave: queue.hasPending,
      debounceMs: 500,
      retryDelayMs: () => 1000,
    });
    holdOnStop(autosave, queue);
  });

  afterEach(() => {
    autosave.dispose();
    expect(server.maxInFlight()).toBeLessThanOrEqual(1);
    vi.useRealTimers();
  });

  it('creates the queued versions in order, each with its own text, then saves the latest text as the draft', async () => {
    offline();
    autosave.edit('Once upon');
    await expect(saveVersion('Once upon', 'First')).resolves.toBe('failed');
    autosave.edit('Once upon a tide');
    await expect(saveVersion('Once upon a tide')).resolves.toBe('failed');
    autosave.edit('Once upon a tide, the keeper slept.');
    expect(queue.getSnapshot().pending).toEqual([
      { text: 'Once upon', name: 'First' },
      { text: 'Once upon a tide', name: undefined },
    ]);
    expect(autosave.getSnapshot().status).toBe('retrying');

    online();
    server.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toEqual([
      'PUT Once upon@1',
      'POST @2 First',
      'PUT Once upon a tide@2',
      'POST @3',
      'PUT Once upon a tide, the keeper slept.@3',
    ]);
    expect(versions()).toEqual([
      ['First', 'Once upon'],
      [null, 'Once upon a tide'],
    ]);
    expect(server.draft()).toEqual({ content: 'Once upon a tide, the keeper slept.', draftVersion: 4 });
    expect(queue.getSnapshot()).toEqual({ pending: [], held: [] });
    expect(autosave.getSnapshot()).toMatchObject({
      status: 'saved',
      base: { content: 'Once upon a tide, the keeper slept.', draftVersion: 4 },
    });
  });

  it('a flush made while versions wait settles only once they are created', async () => {
    offline();
    autosave.edit('Once upon');
    await saveVersion('Once upon');
    online();
    const flushed = autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    await expect(flushed).resolves.toBe('saved');
    expect(versions()).toEqual([[null, 'Once upon']]);
  });

  it('makes one revision of a text queued twice, and none of a text that is the head', async () => {
    offline();
    autosave.edit('Once upon');
    await saveVersion('Once upon');
    await saveVersion('Once upon', 'Named');
    autosave.edit('Once');
    await saveVersion('Once');
    expect(queue.getSnapshot().pending).toEqual([
      { text: 'Once upon', name: 'Named' },
      { text: 'Once', name: undefined },
    ]);

    online();
    await vi.advanceTimersByTimeAsync(1000);
    // "Once" is the head again once "Once upon" is: the server makes a revision of it, as it would have online.
    expect(versions()).toEqual([
      ['Named', 'Once upon'],
      [null, 'Once'],
    ]);
    expect(autosave.getSnapshot().status).toBe('saved');
  });

  it('resumes where it stopped when the server goes away again midway, and creates nothing twice', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A');
    autosave.edit('B');
    await saveVersion('B');
    autosave.edit('C');

    // Back for the first version only: the second one's revision fails.
    let posts = 0;
    server.setFail((call) => (call.startsWith('POST') && ++posts > 1 ? unreachable() : undefined));
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual([[null, 'A']]);
    expect(queue.getSnapshot().pending).toEqual([{ text: 'B', name: undefined }]);
    // The machine knows the server holds B now.
    expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', base: { content: 'B', draftVersion: 3 } });

    online();
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual([
      [null, 'A'],
      [null, 'B'],
    ]);
    expect(server.draft().content).toBe('C');
    expect(autosave.getSnapshot().status).toBe('saved');
  });

  it('a revision whose answer was lost is not created again', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A');
    autosave.edit('B');
    online();
    let posts = 0;
    server.setLose((call) => call.startsWith('POST') && ++posts === 1);
    server.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toEqual(['PUT A@1', 'POST @2']);
    // The machine knows the server holds A: the version's draft, on which the revision is sent again.
    expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', base: { content: 'A', draftVersion: 2 } });
    await vi.advanceTimersByTimeAsync(1000);
    // The revision was made, its answer lost: sent again on the same draft and head, it finds the draft the head.
    expect(server.calls).toEqual(['PUT A@1', 'POST @2', 'PUT A@2', 'POST @2', 'PUT B@2']);
    expect(versions()).toEqual([[null, 'A']]);
    expect(autosave.getSnapshot().status).toBe('saved');
  });

  it('keeps the text typed while a delayed version is being created, and saves it after', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A');
    online();
    server.hold();
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls.at(-1)).toBe('PUT A@1');
    autosave.edit('A, then more');
    await vi.advanceTimersByTimeAsync(5000);
    // Still one request at a time: nothing else was sent.
    expect(server.calls.at(-1)).toBe('PUT A@1');

    await server.release();
    expect(versions()).toEqual([[null, 'A']]);
    expect(server.draft()).toEqual({ content: 'A, then more', draftVersion: 3 });
    expect(autosave.getSnapshot().status).toBe('saved');
  });

  it('a revision whose answer was lost is held, not sent again, once the head moved and its text is back', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A', 'Mine');
    autosave.edit('B');
    online();
    let posts = 0;
    server.setLose((call) => call.startsWith('POST') && ++posts === 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual([['Mine', 'A']]);

    // Another device saves and versions its text, then puts A back in the draft.
    server.otherDraft('Other');
    server.otherVersion();
    server.otherDraft('A');
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual([
      ['Mine', 'A'],
      ['Theirs', 'Other'],
    ]);
    expect(queue.getSnapshot()).toEqual({ pending: [], held: [{ text: 'A', name: 'Mine', reason: 'unsure' }] });
    expect(server.draft().content).toBe('B');
    expect(autosave.getSnapshot().status).toBe('saved');
  });

  it('names a version whose requests are already sent by renaming it once created', async () => {
    autosave.edit('A');
    server.hold();
    const first = saveVersion('A');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toEqual(['PUT A@1']);
    // The name comes while the version's requests are on their way.
    const second = saveVersion('A', 'Named');
    await server.release();
    await expect(first).resolves.toBe('saved');
    await expect(second).resolves.toBe('saved');
    expect(server.calls).toEqual(['PUT A@1', 'POST @2', 'PUT A@2', 'POST @2', 'PATCH 2 Named']);
    expect(versions()).toEqual([['Named', 'A']]);
  });

  describe('a failed write of the latest text after a version was created', () => {
    const failLatestOnce = async () => {
      offline();
      autosave.edit('A');
      await saveVersion('A');
      autosave.edit('B');
      let failed = false;
      server.setFail((call) => {
        if (call !== 'PUT B@2' || failed) return undefined;
        failed = true;
        return unreachable();
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(versions()).toEqual([[null, 'A']]);
      expect(autosave.getSnapshot()).toMatchObject({ status: 'retrying', base: { content: 'A', draftVersion: 2 } });
    };

    it('is a conflict when another device writes the old text back, never a write over it', async () => {
      await failLatestOnce();
      server.otherDraft('Once');
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.draft()).toEqual({ content: 'Once', draftVersion: 3 });
      expect(autosave.getSnapshot()).toMatchObject({ status: 'conflict', base: { content: 'A', draftVersion: 2 } });
    });

    it('takes a read of the version it created as its own', async () => {
      await failLatestOnce();
      read();
      expect(autosave.getSnapshot().status).toBe('retrying');
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.draft().content).toBe('B');
      expect(autosave.getSnapshot().status).toBe('saved');
    });
  });

  it('takes a read of a queued text whose answer was lost as its own, and goes on', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A');
    autosave.edit('B');
    online();
    let puts = 0;
    server.setLose((call) => call.startsWith('PUT A') && ++puts === 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.draft()).toEqual({ content: 'A', draftVersion: 2 });
    read();
    expect(autosave.getSnapshot().status).not.toBe('conflict');
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual([[null, 'A']]);
    expect(server.draft().content).toBe('B');
    expect(queue.getSnapshot()).toEqual({ pending: [], held: [] });
  });

  it('holds the queued versions as soon as a read shows a conflict, so resolving it sends none of them', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A');
    autosave.edit('B');
    server.otherDraft('Theirs');
    read();
    expect(autosave.getSnapshot().status).toBe('conflict');
    expect(queue.getSnapshot()).toEqual({ pending: [], held: [{ text: 'A', name: undefined, reason: 'conflict' }] });

    online();
    autosave.resolve('B and Theirs', server.draft());
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual([]);
    expect(server.draft().content).toBe('B and Theirs');
  });

  it('is tried again on a head another device moved, since the draft did not move', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A');
    headSeen = 0;
    online();
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls.filter((call) => call.startsWith('POST'))).toEqual(['POST @2', 'POST @2']);
    expect(versions()).toEqual([[null, 'A']]);
  });

  describe('when the draft moved on another device meanwhile', () => {
    it('writes no queued text over it: the versions are held, and the latest text is a conflict', async () => {
      offline();
      autosave.edit('A');
      await saveVersion('A', 'Mine');
      autosave.edit('AB');
      server.otherDraft('Theirs');

      online();
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.draft()).toEqual({ content: 'Theirs', draftVersion: 2 });
      expect(versions()).toEqual([]);
      expect(queue.getSnapshot()).toEqual({ pending: [], held: [{ text: 'A', name: 'Mine', reason: 'conflict' }] });
      expect(autosave.getSnapshot()).toMatchObject({
        status: 'conflict',
        content: 'AB',
        server: { content: 'Theirs', draftVersion: 2 },
      });

      queue.discard('A');
      expect(queue.getSnapshot().held).toEqual([]);
    });

    it('keeps the versions already created, holds the rest, and gives the machine the base it confirmed', async () => {
      offline();
      autosave.edit('A');
      await saveVersion('A');
      autosave.edit('B');
      await saveVersion('B');
      autosave.edit('C');

      // The other device writes right after the first version.
      online();
      let posts = 0;
      server.setFail((call) => {
        if (call.startsWith('POST') && ++posts === 1) queueMicrotask(() => server.otherDraft('Theirs'));
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(versions()).toEqual([[null, 'A']]);
      expect(queue.getSnapshot().held).toEqual([{ text: 'B', name: undefined, reason: 'conflict' }]);
      expect(server.draft().content).toBe('Theirs');
      expect(autosave.getSnapshot()).toMatchObject({
        status: 'conflict',
        content: 'C',
        base: { content: 'A', draftVersion: 2 },
        server: { content: 'Theirs', draftVersion: 3 },
      });
    });
  });

  it('holds a version whose text the server refuses, and creates the others', async () => {
    offline();
    autosave.edit('Too large');
    await saveVersion('Too large');
    autosave.edit('Fine');
    await saveVersion('Fine');
    server.setFail((call) => (call.startsWith('PUT Too large') ? apiError(413) : undefined));
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getSnapshot()).toEqual({
      pending: [],
      held: [{ text: 'Too large', name: undefined, reason: 'refused' }],
    });
    expect(versions()).toEqual([[null, 'Fine']]);
    expect(autosave.getSnapshot().status).toBe('saved');
  });

  it('holds every version of a document deleted meanwhile', async () => {
    offline();
    autosave.edit('A');
    await saveVersion('A');
    server.setFail(() => apiError(404));
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getSnapshot().held).toEqual([{ text: 'A', name: undefined, reason: 'deleted' }]);
    expect(autosave.getSnapshot()).toMatchObject({ status: 'rejected', permanent: true });
  });

  it('creates a page not created yet first, then its versions, then its latest text', async () => {
    /** The creation's body: the first text sent, sent again as it is until it is answered. */
    let body: string | undefined;
    let created = false;
    const create = async (draft: Draft): Promise<SaveResult> => {
      body ??= draft.content;
      const result = await server.saveDraft({ content: body, draftVersion: 1 });
      if (result.kind !== 'saved') return result;
      created = true;
      return { ...result, content: body };
    };
    const save = (draft: Draft) => (created ? server.saveDraft(draft) : create(draft));
    autosave.dispose();
    autosave = createAutosave({
      base: { content: '', draftVersion: 0 },
      save: (draft) => queue.send(draft, save, () => !created),
      mustSave: queue.hasPending,
      debounceMs: 500,
      retryDelayMs: () => 1000,
    });
    offline();
    autosave.edit('Page');
    autosave.edit('Page one');
    await expect(saveVersion('Page one')).resolves.toBe('failed');
    autosave.edit('Page one, two');

    online();
    server.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toEqual(['PUT Page one@1', 'PUT Page one@2', 'POST @2', 'PUT Page one, two@2']);
    expect(server.draft().content).toBe('Page one, two');
    expect(versions()).toEqual([[null, 'Page one']]);
    expect(autosave.getSnapshot().status).toBe('saved');
  });

  it('a refused creation is its own text: the page is created with the latest one, the queued text is held', async () => {
    let body: string | undefined;
    let created = false;
    const create = async (draft: Draft): Promise<SaveResult> => {
      body ??= draft.content;
      const result = await server.saveDraft({ content: body, draftVersion: 1 });
      if (result.kind === 'rejected') {
        // Rule 3 of the identity of a page: the server stored nothing, a changed text is a new creation.
        body = undefined;
        return { ...result, permanent: false };
      }
      if (result.kind !== 'saved') return result;
      created = true;
      return { ...result, content: body };
    };
    const save = (draft: Draft) => (created ? server.saveDraft(draft) : create(draft));
    autosave.dispose();
    autosave = createAutosave({
      base: { content: '', draftVersion: 0 },
      save: (draft) => queue.send(draft, save, () => !created),
      mustSave: queue.hasPending,
      debounceMs: 500,
      retryDelayMs: () => 1000,
    });
    holdOnStop(autosave, queue);
    offline();
    autosave.edit('Too large');
    await expect(saveVersion('Too large')).resolves.toBe('failed');
    autosave.edit('Fine');

    server.setFail((call) => (call.startsWith('PUT Too large') ? apiError(413) : undefined));
    server.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toEqual(['PUT Too large@1', 'PUT Fine@1', 'PUT Too large@2']);
    expect(server.draft().content).toBe('Fine');
    expect(queue.getSnapshot()).toEqual({
      pending: [],
      held: [{ text: 'Too large', name: undefined, reason: 'refused' }],
    });
    expect(autosave.getSnapshot()).toMatchObject({ status: 'saved', content: 'Fine' });
  });
});
