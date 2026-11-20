import type { Revision, RevisionSummary } from '@reviewr/shared';
import { ApiError, NetworkError } from '@reviewr/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from './queryKeys';
import { renameError, renameRevision, revisionLabel } from './revisionName';

const summary = (revision: number, name: string | null): RevisionSummary => ({
  documentId: 'doc',
  revision,
  title: 'The lighthouse keeper',
  name,
  createdAt: '2026-11-20T10:00:00.000Z',
});

/** A server whose versions 3, 2 and 1 are listed newest first, as the history shows them. */
const setup = () => {
  const names = new Map<number, string | null>([
    [3, null],
    [2, 'Before restore — 20 Nov'],
    [1, 'First draft'],
  ]);
  let failing: unknown;
  const api = {
    nameRevision: vi.fn(async (_id: string, revision: number, name: string | null) => {
      if (failing !== undefined) throw failing;
      names.set(revision, name);
      return summary(revision, name);
    }),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const list = () => [...names].map(([revision, name]) => summary(revision, name));
  queryClient.setQueryData(queryKeys.revisions('doc'), list());
  const shown = () => queryClient.getQueryData<RevisionSummary[]>(queryKeys.revisions('doc'))?.map((row) => row.name);
  return { api, queryClient, shown, fail: (error: unknown) => (failing = error) };
};

describe('renameRevision', () => {
  it('names a version: the list shows the new name, every other row as it was', async () => {
    const { api, queryClient, shown } = setup();
    await renameRevision(queryClient, api, summary(3, null), '  Read by Claire ');
    expect(api.nameRevision).toHaveBeenCalledWith('doc', 3, 'Read by Claire');
    expect(shown()).toEqual(['Read by Claire', 'Before restore — 20 Nov', 'First draft']);
  });

  it('changes a name, and clears it when the field is blank', async () => {
    const { api, queryClient, shown } = setup();
    await renameRevision(queryClient, api, summary(1, 'First draft'), 'Premier jet');
    expect(shown()).toEqual([null, 'Before restore — 20 Nov', 'Premier jet']);
    await renameRevision(queryClient, api, summary(2, 'Before restore — 20 Nov'), '   ');
    expect(api.nameRevision).toHaveBeenLastCalledWith('doc', 2, null);
    expect(shown()).toEqual([null, null, 'Premier jet']);
  });

  it('gives the new name to the revision read for its preview, with its text unchanged', async () => {
    const { api, queryClient } = setup();
    const full: Revision = { ...summary(1, 'First draft'), content: 'The keeper climbed the stairs.' };
    queryClient.setQueryData(queryKeys.revision('doc', 1), full);
    await renameRevision(queryClient, api, full, 'Premier jet');
    expect(queryClient.getQueryData(queryKeys.revision('doc', 1))).toEqual({ ...full, name: 'Premier jet' });
  });

  it('keeps the old name when the server refuses the rename, and says why', async () => {
    const { api, queryClient, shown, fail } = setup();
    const refused = new ApiError(400, {
      statusCode: 400,
      message: 'name must be shorter than or equal to 200 characters',
    });
    fail(refused);
    await expect(renameRevision(queryClient, api, summary(1, 'First draft'), 'Premier jet')).rejects.toBe(refused);
    expect(shown()).toEqual([null, 'Before restore — 20 Nov', 'First draft']);
    expect(renameError(refused)).toBe('Name not saved: name must be shorter than or equal to 200 characters');
  });

  it('keeps the old name while the server is unreachable, and queues nothing', async () => {
    const { api, queryClient, shown, fail } = setup();
    const unreachable = new NetworkError(new TypeError('Network request failed'));
    fail(unreachable);
    await expect(renameRevision(queryClient, api, summary(3, null), 'Read by Claire')).rejects.toBe(unreachable);
    expect(shown()).toEqual([null, 'Before restore — 20 Nov', 'First draft']);
    expect(api.nameRevision).toHaveBeenCalledTimes(1);
    expect(renameError(unreachable)).toBe('Name not saved: the server is unreachable. Try again once it is back.');
  });
});

describe('revisionLabel', () => {
  it('reads a named version by its name, with its number underneath', () => {
    expect(revisionLabel(summary(2, 'Before restore — 20 Nov'))).toEqual({
      heading: 'Before restore — 20 Nov',
      number: 'Revision 2',
    });
  });

  it('reads an unnamed version by its number', () => {
    expect(revisionLabel(summary(3, null))).toEqual({ heading: 'Revision 3' });
  });
});
