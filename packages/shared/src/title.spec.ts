/* eslint-disable no-null/no-null -- the API sends null for an untitled document */
import { describe, expect, it } from 'vitest';
import { displayTitle, titleToSend } from './title.js';

describe('displayTitle', () => {
  const createdAt: string = '2026-10-30T09:15:00.000Z';

  it('shows the title when there is one', () => {
    expect(displayTitle({ title: 'Chapitre 1', createdAt })).toBe('Chapitre 1');
    expect(displayTitle({ title: '  Spaced  ', createdAt })).toBe('  Spaced  ');
  });

  it('names an untitled document after its creation day', () => {
    expect(displayTitle({ title: null, createdAt }, { timeZone: 'UTC' })).toBe('Untitled — 30 Oct');
  });

  it('treats an absent or blank title as none', () => {
    expect(displayTitle({ createdAt }, { timeZone: 'UTC' })).toBe('Untitled — 30 Oct');
    expect(displayTitle({ title: '', createdAt }, { timeZone: 'UTC' })).toBe('Untitled — 30 Oct');
    expect(displayTitle({ title: ' \n\t', createdAt }, { timeZone: 'UTC' })).toBe('Untitled — 30 Oct');
  });

  it('reads the day in the given time zone', () => {
    const lateEvening: string = '2026-10-30T23:30:00.000Z';
    expect(displayTitle({ title: null, createdAt: lateEvening }, { timeZone: 'UTC' })).toBe('Untitled — 30 Oct');
    expect(displayTitle({ title: null, createdAt: lateEvening }, { timeZone: 'Europe/Paris' })).toBe(
      'Untitled — 31 Oct',
    );
    expect(displayTitle({ title: null, createdAt: lateEvening }, { timeZone: 'America/New_York' })).toBe(
      'Untitled — 30 Oct',
    );
  });

  it('writes single-digit days without padding', () => {
    expect(displayTitle({ title: null, createdAt: '2026-03-05T12:00:00.000Z' }, { timeZone: 'UTC' })).toBe(
      'Untitled — 5 Mar',
    );
  });
});

describe('titleToSend', () => {
  it('keeps a typed title as it is', () => {
    expect(titleToSend('Chapitre 1')).toBe('Chapitre 1');
    expect(titleToSend(' a ')).toBe(' a ');
  });

  it('turns an empty or blank field into no title', () => {
    expect(titleToSend('')).toBeUndefined();
    expect(titleToSend('   ')).toBeUndefined();
  });
});
