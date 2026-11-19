import { ApiError, NetworkError, type CreateDraftDocumentInput } from '@reviewr/shared';
import { describe, expect, it } from 'vitest';
import { FakeApi } from './fakeApi';
import { createNewDocument } from './newDocument';

/** "New" on the list screen, on a fake server, with ids `id-1`, `id-2`… */
const setup = () => {
  const server = FakeApi.draftOnly('', 'unused');
  let count = 0;
  const create = createNewDocument({ api: server, newId: () => `id-${++count}` });
  return { server, create };
};

describe('createNewDocument', () => {
  it('creates an empty draft-only document under an id of its own: no version in its history', async () => {
    const { server, create } = setup();
    const document = await create();
    expect(document).toMatchObject({
      id: 'id-1',
      revision: 0,
      content: '',
      draft: { content: '', draftVersion: 1, baseRevision: null },
    });
    expect(server.revisions).toEqual([]);
    expect((await create()).id).toBe('id-2');
  });

  it('sends the draft-only form of the creation, with an empty text', async () => {
    const server = FakeApi.draftOnly('', 'unused');
    const sent: CreateDraftDocumentInput[] = [];
    const create = createNewDocument({
      api: {
        createDocument: (input) => {
          sent.push(input);
          return server.createDocument(input);
        },
      },
      newId: () => 'id-1',
    });
    await create();
    expect(sent).toEqual([{ id: 'id-1', content: '', draftOnly: true }]);
  });

  it('sends a creation whose answer was lost again on the same id: the one document opens, no second one', async () => {
    const { server, create } = setup();
    server.lostAnswers = 1;
    await expect(create()).rejects.toBeInstanceOf(NetworkError);
    expect((await create()).id).toBe('id-1');
    expect([...server.creations.keys()]).toEqual(['id-1']);
    expect(server.log).toEqual(['createDocument id-1', 'createDocument id-1']);
  });

  it('keeps the id while the server is unreachable or answers a 5xx', async () => {
    const { server, create } = setup();
    server.failing = new NetworkError(new TypeError('offline'));
    await expect(create()).rejects.toBeDefined();
    server.failing = new ApiError(503, { statusCode: 503, message: 'Unavailable' });
    await expect(create()).rejects.toBeDefined();
    server.failing = new ApiError(429, { statusCode: 429, message: 'Too many requests' });
    await expect(create()).rejects.toBeDefined();
    server.failing = undefined;
    expect((await create()).id).toBe('id-1');
  });

  it('takes a new id after a refusal, so a 410 or a 422 never loops', async () => {
    const { server, create } = setup();
    server.lostAnswers = 1;
    await expect(create()).rejects.toBeDefined();
    // Deleted on another device before the creation was sent again: 410, then a new document.
    server.gone = true;
    await expect(create()).rejects.toMatchObject({ status: 410 });
    expect((await create()).id).toBe('id-2');

    // The same id used with another body: 422, then a new document.
    server.creations.set('id-3', 'another body');
    await expect(create()).rejects.toMatchObject({ status: 422 });
    expect((await create()).id).toBe('id-4');
  });

  it('a tap while a creation is under way waits for it, and sends nothing more', async () => {
    const { server, create } = setup();
    server.paused = true;
    const first = create();
    const second = create();
    server.paused = false;
    server.release();
    expect(await second).toEqual(await first);
    expect(server.log).toEqual(['createDocument id-1']);
  });
});
