/*
 * The check that the Hermes tests run on the mobile app's Hermes, on the real pnpm-lock.yaml and on broken copies of
 * it. Run by `pnpm test`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkMobileHermes, readLockfile } from './lockfile.mjs';

const lockfile = readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');
const pinned = /^HERMES_VERSION=(.*)$/mu.exec(readFileSync(new URL('hermes.env', import.meta.url), 'utf8'))[1];

/** The lockfile with `search` replaced, failing the test if it is not there. */
const edit = (search, replacement) => {
  expect(lockfile).toContain(search);

  return lockfile.replaceAll(search, replacement);
};

/** The lines of the mobile app's react-native dependency. */
const mobileReactNative =
  /\n {2}apps\/mobile:\n(?: {4}.*\n| {6}.*\n| {8}.*\n)*? {6}react-native:\n {8}specifier: .*\n {8}version: .*\n/u;

describe('the mobile app Hermes check', () => {
  it('accepts the current lockfile, whose mobile app ships the pinned Hermes', () => {
    expect(checkMobileHermes(lockfile, pinned)).toBe(pinned);
  });

  it('fails without the mobile app importer', () => {
    expect(() => checkMobileHermes(edit('\n  apps/mobile:\n', '\n  apps/elsewhere:\n'), pinned)).toThrow(
      "Cannot find the mobile app's Hermes: pnpm-lock.yaml has no importer apps/mobile. Update packages/merge/hermes/hermes.env",
    );
  });

  it('fails without the mobile app react-native dependency, even if another package keeps the compiler', () => {
    const [block] = mobileReactNative.exec(lockfile);
    const withoutDependency = lockfile.replace(block, block.replace(/ {6}react-native:\n {8}.*\n {8}.*\n$/u, ''));
    expect(readLockfile(withoutDependency)[1].packages[`hermes-compiler@${pinned}`]).toBeDefined();
    expect(() => checkMobileHermes(withoutDependency, pinned)).toThrow(
      'apps/mobile has no resolved react-native dependency in pnpm-lock.yaml',
    );
  });

  it('fails when the mobile app react-native has no hermes-compiler', () => {
    expect(() => checkMobileHermes(edit(`      hermes-compiler: ${pinned}\n`, ''), pinned)).toThrow(
      "pnpm-lock.yaml has no hermes-compiler for the mobile app's react-native@0.88.0(",
    );
  });

  it('fails when the mobile app ships another Hermes', () => {
    const upgraded = edit(`hermes-compiler: ${pinned}`, 'hermes-compiler: 270101000.0.0').replaceAll(
      `hermes-compiler@${pinned}`,
      'hermes-compiler@270101000.0.0',
    );
    expect(() => checkMobileHermes(upgraded, pinned)).toThrow(
      `The mobile app ships Hermes 270101000.0.0, but the tests run on Hermes ${pinned}. Update packages/merge/hermes/hermes.env`,
    );
  });

  it('ignores another hermes-compiler that the mobile app does not use', () => {
    const other = edit('\nsnapshots:\n', '\nsnapshots:\n\n  hermes-compiler@1.0.0: {}\n').replace(
      '\npackages:\n',
      '\npackages:\n\n  hermes-compiler@1.0.0:\n    resolution: {integrity: sha512-x}\n',
    );
    expect(checkMobileHermes(other, pinned)).toBe(pinned);
  });

  it.each([
    ['a comment', '\nsnapshots:\n', '\n# a comment\nsnapshots:\n'],
    ['a double-quoted value', "lockfileVersion: '9.0'", 'lockfileVersion: "9.0"'],
    ['a duplicate key', '\nsnapshots:\n', '\nsettings:\n  a: b\nsnapshots:\n'],
    ['a stray indent', '\nsnapshots:\n', '\n   odd: indent\nsnapshots:\n'],
  ])('fails closed on YAML it does not read: %s', (_name, search, replacement) => {
    expect(() => checkMobileHermes(edit(search, replacement), pinned)).toThrow("Cannot find the mobile app's Hermes");
  });
});
