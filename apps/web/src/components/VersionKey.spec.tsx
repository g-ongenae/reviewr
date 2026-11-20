import type { CreateRevisionInput, Document, SaveDraftInput } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { createQueryClient } from '../queryClient';
import { DocumentView } from './DocumentView';

const fetchMock = vi.mocked(fetch);

const reply = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(structuredClone(body))),
  }) as unknown as Response;

const conflict = (body: object) => reply(409, { statusCode: 409, message: 'Conflict', ...body });

let document: Document;
/** Versions created, with their name and text. */
let versions: [string | null, string][];
/** Bodies of every "Save version" request, in order. */
let posts: CreateRevisionInput[];
/** Revision saved under each idempotency key, with the request it answered. */
let keys: Map<string, { request: string; revision: number }>;
/** The next "Save version" is carried out, but its answer is lost on the way back (502). */
let loseNextAnswer: boolean;
/** Called when a "Save version" request arrives, before the server reads the document: another device, say. */
let beforePost: (() => void) | undefined;

/** The API's rules for the draft and the revisions of one document, idempotency keys included. */
const fakeApi = (method: string, path: string, body: unknown): Response => {
  const { draft } = document;
  if (draft === undefined) throw new Error('No draft');
  if (method === 'GET' && path.endsWith('/revisions')) return reply(200, []);
  if (method === 'GET') return reply(200, document);
  if (method === 'PUT') {
    const input = body as SaveDraftInput;
    if (draft.content === input.content) return reply(200, draft);
    if (draft.draftVersion !== input.draftVersion) return conflict({ code: 'draft_conflict', draft });
    document = { ...document, draft: { ...draft, content: input.content, draftVersion: draft.draftVersion + 1 } };
    return reply(200, document.draft);
  }
  const input = body as CreateRevisionInput;
  posts.push(input);
  beforePost?.();
  const { idempotencyKey, ...rest } = input;
  const request = JSON.stringify([rest.draftVersion, rest.baseRevision ?? 0, rest.name ?? null]);
  const recorded = idempotencyKey === undefined ? undefined : keys.get(idempotencyKey);
  if (recorded !== undefined) {
    if (recorded.request !== request) return reply(422, { statusCode: 422, message: 'Key used for another request' });
    return reply(200, { ...document, savedRevision: recorded.revision });
  }
  const current = document.draft ?? draft;
  if (current.draftVersion !== input.draftVersion) return conflict({ code: 'draft_conflict', draft: current });
  if (current.content === document.content) return reply(200, document);
  if (document.revision !== (input.baseRevision ?? 0)) {
    return conflict({ code: 'stale_revision', revision: document.revision });
  }
  document = { ...document, revision: document.revision + 1, content: current.content };
  versions.push([input.name ?? null, current.content]);
  if (idempotencyKey !== undefined) keys.set(idempotencyKey, { request, revision: document.revision });
  if (loseNextAnswer) {
    loseNextAnswer = false;
    return reply(502);
  }
  return reply(200, { ...document, savedRevision: document.revision });
};

/** Another device saves a draft of its own, then a version of it. */
const versionElsewhere = (content: string) => {
  const draftVersion = (document.draft?.draftVersion ?? 0) + 1;
  document = {
    ...document,
    revision: document.revision + 1,
    content,
    draft: { content, draftVersion, baseRevision: document.revision + 1 },
  };
  versions.push([null, content]);
};

let queryClient: QueryClient;

const open = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DocumentView id="doc-1" onDeleted={() => {}} onGoBack={() => {}} onOpen={() => {}} />
    </QueryClientProvider>,
  );

const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const type = (value: string) => fireEvent.change(screen.getByPlaceholderText('Start writing…'), { target: { value } });
const saveVersion = async (name?: string) => {
  if (name === undefined) {
    fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'Name this version' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Version name' }), { target: { value: name } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Version name' }));
  }
  await elapse();
};
const notice = () => screen.queryByText(/version (could not be|was not) saved/i)?.textContent;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  const content = 'Once upon a tide.';
  document = {
    id: 'doc-1',
    title: 'The lighthouse keeper',
    revision: 2,
    content,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    draft: { content, draftVersion: 3, baseRevision: 2 },
  };
  versions = [];
  posts = [];
  keys = new Map();
  loseNextAnswer = false;
  beforePost = undefined;
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  queryClient.setQueryData(queryKeys.document('doc-1'), document);
  fetchMock.mockImplementation((input, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost').pathname;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    return Promise.resolve(fakeApi(method, path, body));
  });
});

afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('"Save version" sent again after a lost answer', () => {
  it('is answered with the version already made, although the draft and the head moved since', async () => {
    open();
    type('Mine.');
    loseNextAnswer = true;
    await saveVersion();
    expect(notice()).toContain('The version could not be saved');
    expect(versions).toEqual([[null, 'Mine.']]);

    // Another device then writes and saves a version of its own; this tab has not read it yet.
    versionElsewhere('Theirs.');
    await saveVersion();

    // Nothing is created twice, and no conflict is shown: the version exists.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(notice()).toBeUndefined();
    expect(versions).toEqual([
      [null, 'Mine.'],
      [null, 'Theirs.'],
    ]);
    // It was the same request, with the same key.
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[0]?.idempotencyKey).toMatch(uuid);
    // The answer is the document as it is now: its newer draft is read as any other, over no unsaved text.
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…').value).toBe('Theirs.');
  });

  it('takes a new key once the request changed: another name, or more text', async () => {
    open();
    type('Mine.');
    loseNextAnswer = true;
    await saveVersion('Dawn');
    await saveVersion('Dusk');
    // The draft already is the head: the version made first keeps its name, and nothing else is created.
    expect(posts[1]?.idempotencyKey).not.toBe(posts[0]?.idempotencyKey);
    expect(versions).toEqual([['Dawn', 'Mine.']]);
    expect(notice()).toBeUndefined();

    loseNextAnswer = true;
    type('Mine. And more.');
    await elapse(5_000);
    await saveVersion();
    type('Mine. And more, again.');
    await elapse(5_000);
    await saveVersion();
    // The last one met the head moved by the version whose answer was lost, and was retried on it: each had its key.
    expect(posts.map((post) => post.baseRevision)).toEqual([2, 2, 3, 3, 4]);
    expect(new Set(posts.map((post) => post.idempotencyKey)).size).toBe(posts.length);
    expect(versions).toEqual([
      ['Dawn', 'Mine.'],
      [null, 'Mine. And more.'],
      [null, 'Mine. And more, again.'],
    ]);
  });

  it('takes a new key on the new head after a stale revision: that was an answer', async () => {
    open();
    type('Mine.');
    await elapse(5_000);
    // A version elsewhere of another text, then that text back in the draft: the head moved, not the draft.
    document = { ...document, revision: 3, content: 'Elsewhere.' };
    await saveVersion();
    expect(posts.map((post) => post.baseRevision)).toEqual([2, 3]);
    expect(posts[1]?.idempotencyKey).not.toBe(posts[0]?.idempotencyKey);
    expect(versions).toEqual([[null, 'Mine.']]);
    expect(notice()).toBeUndefined();
  });
});

describe('"Save version" on a draft whose counter moved, with the same text', () => {
  /** The server's draft takes `content` on a later counter, as a save of this device given up, or another device. */
  const draftElsewhere = (content: string) => {
    const { draft } = document;
    if (draft === undefined) throw new Error('No draft');
    document = { ...document, draft: { ...draft, content, draftVersion: draft.draftVersion + 1 } };
  };
  const typeAndSave = async (text: string) => {
    type(text);
    await elapse(5_000);
    expect(document.draft?.content).toBe(text);
  };

  it('saves the version in one click when only the counter moved', async () => {
    open();
    await typeAndSave('Mine.');
    draftElsewhere('Mine.');
    await saveVersion('Dawn');

    expect(versions).toEqual([['Dawn', 'Mine.']]);
    expect(notice()).toBeUndefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Saved · revision 3')).toBeTruthy();
    // Sent again on the server's counter, with a key of its own: the 409 was an answer, which ended the first key.
    expect(posts.map((post) => post.draftVersion)).toEqual([4, 5]);
    expect(posts[1]?.idempotencyKey).toMatch(uuid);
    expect(posts[1]?.idempotencyKey).not.toBe(posts[0]?.idempotencyKey);

    // The autosave goes on from the new counter: the next edit is saved without a conflict.
    type('Mine. More.');
    await elapse(5_000);
    expect(document.draft).toMatchObject({ content: 'Mine. More.', draftVersion: 6 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends the retry on the new counter again as it was when its answer was lost', async () => {
    open();
    await typeAndSave('Mine.');
    draftElsewhere('Mine.');
    // The retry on the server's counter is applied, but its answer is lost on the way back.
    loseNextAnswer = true;
    await saveVersion('Dawn');
    expect(notice()).toContain('The version could not be saved');
    expect(versions).toEqual([['Dawn', 'Mine.']]);
    expect(posts.map((post) => post.draftVersion)).toEqual([4, 5]);

    await saveVersion('Dawn');
    // Exactly the request whose answer was lost: same counter, same key; the server answers the version it made.
    expect(posts).toHaveLength(3);
    expect(posts[2]).toEqual(posts[1]);
    expect(versions).toEqual([['Dawn', 'Mine.']]);
    expect(notice()).toBeUndefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves it too when another device changed the text and came back to it', async () => {
    open();
    await typeAndSave('Mine.');
    beforePost = () => {
      beforePost = undefined;
      draftElsewhere('Theirs.');
      draftElsewhere('Mine.');
    };
    await saveVersion();

    expect(versions).toEqual([[null, 'Mine.']]);
    expect(notice()).toBeUndefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(posts.map((post) => post.draftVersion)).toEqual([4, 6]);
  });

  it('goes on after a stale revision too: the head and the counter both moved', async () => {
    open();
    await typeAndSave('Mine.');
    draftElsewhere('Mine.');
    document = { ...document, revision: 3, content: 'Elsewhere.' };
    versions.push([null, 'Elsewhere.']);
    await saveVersion();

    expect(versions).toEqual([
      [null, 'Elsewhere.'],
      [null, 'Mine.'],
    ]);
    expect(notice()).toBeUndefined();
    expect(posts.map((post) => [post.draftVersion, post.baseRevision])).toEqual([
      [4, 2],
      [5, 2],
      [5, 3],
    ]);
    expect(new Set(posts.map((post) => post.idempotencyKey)).size).toBe(3);
  });

  it('is a conflict as before when the draft holds another text: no version is saved', async () => {
    open();
    await typeAndSave('Mine.');
    draftElsewhere('Theirs.');
    await saveVersion();

    expect(posts).toHaveLength(1);
    expect(versions).toEqual([]);
    // The conflict has its own banner, as before.
    expect(screen.getByRole('alert').textContent).toContain('This text was also changed on another device.');
    expect(screen.getByText('Not saved · changed elsewhere')).toBeTruthy();
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…').value).toBe('Mine.');
  });

  it('stops after three tries when the counter keeps moving, with the message of a moved text', async () => {
    open();
    await typeAndSave('Mine.');
    beforePost = () => draftElsewhere('Mine.');
    await saveVersion();

    expect(posts).toHaveLength(3);
    expect(versions).toEqual([]);
    expect(notice()).toContain('the text changed while it was being saved');
    // Nothing is lost: the text is the server's, and a second click saves it once the counter stays.
    beforePost = undefined;
    await saveVersion();
    expect(versions).toEqual([[null, 'Mine.']]);
    expect(notice()).toBeUndefined();
  });
});
