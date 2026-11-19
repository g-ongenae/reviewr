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

  it('a rename to no title stays against a late read', async () => {
    const reading = lateRead();
    server = { ...server, title: null };
    cacheRename(queryClient, server);
    release();
    expect((await reading).title).toBeNull();
  });
});
