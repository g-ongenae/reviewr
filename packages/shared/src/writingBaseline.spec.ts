import { describe, expect, it } from 'vitest';
import {
  lastRevisionBaseline,
  lastRevisionBefore,
  previousRevisionOf,
  startOfDay,
  startOfNextDay,
  todayBaseline,
  todayNeedsHistory,
} from './writingBaseline.js';

const today = new Date(2026, 10, 18).getTime();
const lastWeek = new Date(2026, 10, 11, 10).toISOString();
const thisMorning = new Date(2026, 10, 18, 9).toISOString();
const nothing = { data: undefined, isError: false };
const failed = { data: undefined, isError: true };
const history = {
  data: [
    { revision: 3, createdAt: thisMorning },
    { revision: 2, createdAt: lastWeek },
    { revision: 1, createdAt: lastWeek },
  ],
  isError: false,
};

describe('startOfDay and startOfNextDay', () => {
  it('give the local midnights around a moment', () => {
    expect(startOfDay(new Date(2026, 10, 18, 15, 30).getTime())).toBe(today);
    expect(startOfNextDay(today)).toBe(new Date(2026, 10, 19).getTime());
  });
});

describe('todayBaseline', () => {
  const savedToday = { content: 'Now.', createdAt: lastWeek, updatedAt: thisMorning };

  it('is empty for a document created today, without reading the history', () => {
    const createdToday = { content: 'New.', createdAt: thisMorning, updatedAt: thisMorning };
    expect(todayNeedsHistory(createdToday, today)).toBe(false);
    expect(todayBaseline(createdToday, today, nothing, nothing)).toEqual({ status: 'ready', content: '' });
  });

  it('is the text itself for a document not saved today, without reading the history', () => {
    const untouched = { content: 'Old.', createdAt: lastWeek, updatedAt: lastWeek };
    expect(todayNeedsHistory(untouched, today)).toBe(false);
    expect(todayBaseline(untouched, today, nothing, nothing)).toEqual({ status: 'ready', content: 'Old.' });
  });

  it('is the last revision saved before today, once read', () => {
    expect(todayNeedsHistory(savedToday, today)).toBe(true);
    expect(lastRevisionBefore(history.data, today)).toBe(2);
    expect(todayBaseline(savedToday, today, history, { data: { content: 'Before.' }, isError: false })).toEqual({
      status: 'ready',
      content: 'Before.',
    });
  });

  it('is empty when every revision was saved today', () => {
    const onlyToday = { data: [{ revision: 1, createdAt: thisMorning }], isError: false };
    expect(lastRevisionBefore(onlyToday.data, today)).toBeUndefined();
    expect(todayBaseline(savedToday, today, onlyToday, nothing)).toEqual({ status: 'ready', content: '' });
  });

  it('is loading while a read runs, and unavailable when one failed', () => {
    expect(todayBaseline(savedToday, today, nothing, nothing)).toEqual({ status: 'loading' });
    expect(todayBaseline(savedToday, today, failed, nothing)).toEqual({ status: 'unavailable' });
    expect(todayBaseline(savedToday, today, history, nothing)).toEqual({ status: 'loading' });
    expect(todayBaseline(savedToday, today, history, failed)).toEqual({ status: 'unavailable' });
  });
});

describe('lastRevisionBaseline', () => {
  it('is empty for a text with one revision or none, without reading anything', () => {
    expect(previousRevisionOf({ revision: 0 })).toBe(0);
    expect(previousRevisionOf({ revision: 1 })).toBe(0);
    expect(lastRevisionBaseline({ revision: 1 }, nothing)).toEqual({ status: 'ready', content: '' });
  });

  it('is the revision before the saved one, loading while it is read and unavailable when the read failed', () => {
    expect(previousRevisionOf({ revision: 3 })).toBe(2);
    expect(lastRevisionBaseline({ revision: 3 }, { data: { content: 'Two.' }, isError: false })).toEqual({
      status: 'ready',
      content: 'Two.',
    });
    expect(lastRevisionBaseline({ revision: 3 }, nothing)).toEqual({ status: 'loading' });
    expect(lastRevisionBaseline({ revision: 3 }, failed)).toEqual({ status: 'unavailable' });
  });
});
