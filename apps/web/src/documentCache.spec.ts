import type { Document } from '@reviewr/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from './api';
import { cacheRename, readDocument, seeDraft, writeDocument } from './documentCache';

const fetchMock = vi.mocked(fetch);
const key = queryKeys.document('doc');

const opened: Document = {
  id: 'doc',
  title: 'Title',
  revision: 1,
  content: 'A',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  draft: { content: 'A', draftVersion: 1, baseRevision: 1 },
};

const reply = (body: Document) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) }) as unknown as Response;

let queryClient: QueryClient;
/** The server's document, as a read sent now finds it. */
let server: Document;
/** Answers of reads held back: each read the server answered when it arrived, delivered only at `release`. */
let held: (() => void)[];

/** A read the server answers now; its answer arrives at `release`. */
const lateRead = () => {
  const answer = reply(server);
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => held.push(() => resolve(answer))));
  return readDocument(queryClient, 'doc');
};

const release = () => {
  for (const answer of held.splice(0)) answer();
};

beforeEach(() => {
  queryClient = new QueryClient();
  server = opened;
  held = [];
  fetchMock.mockImplementation(() => Promise.resolve(reply(server)));
  queryClient.setQueryData(key, opened);
});

afterEach(() => {
  fetchMock.mockReset();
});

describe('documentCache: no cache write goes back', () => {
  it('a late read keeps the draft saved since, once the query is dropped too', async () => {
    const reading = lateRead();
    server = { ...server, draft: { content: 'B', draftVersion: 2, baseRevision: 1 } };
    seeDraft(queryClient, 'doc', server.draft!);
    queryClient.removeQueries({ queryKey: key });
    release();
    expect((await reading).draft).toMatchObject({ content: 'B', draftVersion: 2 });

    // A newer answer still goes through: another device's draft.
    server = { ...server, draft: { content: 'C', draftVersion: 3, baseRevision: 1 } };
    expect((await readDocument(queryClient, 'doc')).draft).toMatchObject({ content: 'C', draftVersion: 3 });
  });

  it('a write never takes the head back under a version seen', () => {
    const version = { ...opened, revision: 2, content: 'B', draft: { content: 'B', draftVersion: 2, baseRevision: 2 } };
    writeDocument(queryClient, 'doc', () => version);
    writeDocument(queryClient, 'doc', () => opened);
    expect(queryClient.getQueryData<Document>(key)).toMatchObject({ revision: 2, content: 'B', draft: { content: 'B' } });
  });

  it('a read that started before a rename was confirmed takes the renamed title; one started after, the server’s', async () => {
    const reading = lateRead();
    server = { ...server, title: 'Renamed' };
    cacheRename(queryClient, server);
    expect(queryClient.getQueryData<Document>(key)?.title).toBe('Renamed');
    release();
    expect((await reading).title).toBe('Renamed');

    // Another device's rename, read after this tab's was confirmed.
    server = { ...server, title: 'Renamed elsewhere' };
    expect((await readDocument(queryClient, 'doc')).title).toBe('Renamed elsewhere');
  });

  it('a version made from an unchanged draft moves its base, at the same draft counter', async () => {
    server = { ...opened, revision: 2, draft: { ...opened.draft!, baseRevision: 2 } };
    expect((await readDocument(queryClient, 'doc')).draft).toMatchObject({ draftVersion: 1, baseRevision: 2 });
    writeDocument(queryClient, 'doc', () => opened);
    expect(queryClient.getQueryData<Document>(key)?.draft).toMatchObject({ draftVersion: 1, baseRevision: 2 });
  });

  describe('a document created again under the same id', () => {
    const replacement: Document = {
      ...opened,
      title: 'Another',
      content: 'B',
      createdAt: '2026-11-03T10:00:00.000Z',
      draft: { content: 'B', draftVersion: 1, baseRevision: 1 },
    };

    it('is read as it is, with the same counters and no 404 seen in between', async () => {
      await readDocument(queryClient, 'doc');
      server = replacement;
      expect(await readDocument(queryClient, 'doc')).toEqual(replacement);
    });

    it('keeps its text against a late read of the deleted one', async () => {
      server = { ...opened, draft: { content: 'A2', draftVersion: 2, baseRevision: 1 } };
      const reading = lateRead();
      server = replacement;
      await readDocument(queryClient, 'doc');
      release();
      expect(await reading).toMatchObject({ content: 'B', draft: { content: 'B', draftVersion: 1 } });
    });

    it('starts over once a read answered 404', async () => {
      server = { ...opened, revision: 3, content: 'A3', draft: { content: 'A3', draftVersion: 5, baseRevision: 3 } };
      await readDocument(queryClient, 'doc');
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ statusCode: 404, message: 'Not found' }),
        } as unknown as Response),
      );
      await expect(readDocument(queryClient, 'doc')).rejects.toThrow();
      // Even with its `createdAt` (a clock gone back), the document read next is taken as it is.
      server = { ...opened, content: 'B', draft: { content: 'B', draftVersion: 1, baseRevision: 1 } };
      expect(await readDocument(queryClient, 'doc')).toMatchObject({ revision: 1, draft: { content: 'B' } });
    });
  });

  it('a rename to no title stays against a late read', async () => {
    const reading = lateRead();
    server = { ...server, title: null };
    cacheRename(queryClient, server);
    release();
    expect((await reading).title).toBeNull();
  });
});
