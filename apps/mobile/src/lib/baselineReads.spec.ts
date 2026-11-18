import { describe, expect, it } from 'vitest';
import { baselineReads } from './baselineReads';

const needsAll = { history: true, lastBeforeToday: 2, previous: 2 };

describe('baselineReads', () => {
  it('reads nothing while the panel is hidden, or while the stored choice is not known', () => {
    const none = { revisions: false, todayRevision: false, previousRevision: false };
    expect(baselineReads(false, needsAll)).toEqual(none);
    expect(baselineReads(undefined, needsAll)).toEqual(none);
  });

  it('reads what the shown panel needs, and only that', () => {
    expect(baselineReads(true, needsAll)).toEqual({ revisions: true, todayRevision: true, previousRevision: true });
    expect(baselineReads(true, { history: true, lastBeforeToday: undefined, previous: 0 })).toEqual({
      revisions: true,
      todayRevision: false,
      previousRevision: false,
    });
    expect(baselineReads(true, { history: false, lastBeforeToday: undefined, previous: 1 })).toEqual({
      revisions: false,
      todayRevision: false,
      previousRevision: true,
    });
  });
});
