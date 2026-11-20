import { ApiError, NetworkError } from '@reviewr/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { sameTextMoved, settleVersionRequest, versionRequest } from './versionRequest';

const draftConflict = (content: string, draftVersion: number) => ({
  statusCode: 409,
  message: 'Conflict',
  code: 'draft_conflict' as const,
  draft: { content, draftVersion, baseRevision: 2 },
});

describe('versionRequest', () => {
  it('takes a new key on the new counter after a draft conflict: the 409 ended the first one', () => {
    const queryClient = new QueryClient();
    const first = versionRequest(queryClient, 'doc', { name: 'Dawn', draftVersion: 4, baseRevision: 2 });
    settleVersionRequest(queryClient, 'doc', first, new ApiError(409, draftConflict('Mine.', 5)));
    const second = versionRequest(queryClient, 'doc', { name: 'Dawn', draftVersion: 5, baseRevision: 2 });
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    // Even on the same counter, a request answered is never sent again with its key.
    const third = versionRequest(queryClient, 'doc', { name: 'Dawn', draftVersion: 4, baseRevision: 2 });
    expect(third.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('takes a new key on another counter even after a lost answer: that is another request', () => {
    const queryClient = new QueryClient();
    const first = versionRequest(queryClient, 'doc', { draftVersion: 4, baseRevision: 2 });
    settleVersionRequest(queryClient, 'doc', first, new NetworkError(new TypeError('offline')));
    expect(versionRequest(queryClient, 'doc', { draftVersion: 4, baseRevision: 2 })).toBe(first);
    expect(versionRequest(queryClient, 'doc', { draftVersion: 5, baseRevision: 2 }).idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
  });
});

describe('sameTextMoved', () => {
  it('holds for a later draft with the very text asked for', () => {
    expect(sameTextMoved(draftConflict('Mine.', 5), 'Mine.', 4)).toBe(true);
  });

  it('does not hold for another text, an older counter, or another conflict', () => {
    expect(sameTextMoved(draftConflict('Theirs.', 5), 'Mine.', 4)).toBe(false);
    expect(sameTextMoved(draftConflict('Mine. ', 5), 'Mine.', 4)).toBe(false);
    expect(sameTextMoved(draftConflict('Mine.', 4), 'Mine.', 4)).toBe(false);
    expect(
      sameTextMoved({ statusCode: 409, message: 'Conflict', code: 'stale_revision', revision: 3 }, 'Mine.', 4),
    ).toBe(false);
    expect(sameTextMoved(undefined, 'Mine.', 4)).toBe(false);
  });
});
