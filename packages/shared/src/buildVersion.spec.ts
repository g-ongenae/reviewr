import { describe, expect, it } from 'vitest';
import { formatBuildVersion, readBuildVersion, type RunGit } from './buildVersion.js';

const now: Date = new Date('2026-11-19T22:10:00.000Z');

describe('readBuildVersion', () => {
  const gitAnswering =
    (head: string, status: string): RunGit =>
    (args) =>
      args[0] === 'rev-parse' ? `${head}\n` : status;

  it('reads the commit and the build date', () => {
    expect(readBuildVersion(gitAnswering('eae0529', ''), now)).toEqual({
      commit: 'eae0529',
      dirty: false,
      builtAt: '2026-11-19T22:10:00.000Z',
    });
  });

  it('says when the checkout has uncommitted changes', () => {
    expect(readBuildVersion(gitAnswering('eae0529', ' M apps/web/src/App.tsx\n'), now).dirty).toBe(true);
  });

  it('leaves the commit out when git is missing or fails', () => {
    const missing: RunGit = () => {
      throw new Error('spawnSync git ENOENT');
    };
    expect(readBuildVersion(missing, now)).toEqual({ dirty: false, builtAt: '2026-11-19T22:10:00.000Z' });
    expect(readBuildVersion(gitAnswering('', ''), now)).toEqual({ dirty: false, builtAt: '2026-11-19T22:10:00.000Z' });
  });
});

describe('formatBuildVersion', () => {
  const compiled = (version: object): string => JSON.stringify(version);
  const options = { timeZone: 'Europe/Paris' };

  it('shows the commit and when it was built, in the device time zone', () => {
    const version: string = compiled({ commit: 'eae0529', dirty: false, builtAt: '2026-11-19T22:10:00.000Z' });
    expect(formatBuildVersion(version, options)).toBe('eae0529 · 19 Nov 23:10');
    expect(formatBuildVersion(version, { timeZone: 'UTC' })).toBe('eae0529 · 19 Nov 22:10');
  });

  it('marks a build with uncommitted changes', () => {
    const version: string = compiled({ commit: 'eae0529', dirty: true, builtAt: '2026-11-19T07:05:00.000Z' });
    expect(formatBuildVersion(version, options)).toBe('eae0529+ · 19 Nov 08:05');
  });

  it('says "unknown" for a commit git could not tell', () => {
    expect(formatBuildVersion(compiled({ dirty: false, builtAt: '2026-11-19T22:10:00.000Z' }), options)).toBe(
      'unknown · 19 Nov 23:10',
    );
  });

  it('says "unknown" when the bundle holds no version', () => {
    expect(formatBuildVersion(undefined)).toBe('unknown');
    expect(formatBuildVersion('')).toBe('unknown');
    expect(formatBuildVersion('not json')).toBe('unknown');
    expect(formatBuildVersion('null')).toBe('unknown');
    expect(formatBuildVersion(compiled({ commit: 'eae0529', builtAt: 'yesterday' }))).toBe('unknown');
  });
});
