import { describe, expect, it } from 'vitest';
import { versionName } from './keepSides';

describe('versionName', () => {
  it('names the side and the day, day first with an English month', () => {
    const day = new Date(2026, 10, 13, 12);
    expect(versionName('theirs', day)).toBe('Other device — 13 Nov');
    expect(versionName('mine', day)).toBe('This device — 13 Nov');
  });
});
