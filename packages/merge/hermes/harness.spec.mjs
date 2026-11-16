/*
 * The Hermes harness against Vitest itself, run by `pnpm test` (not on Hermes, where it would only compare the harness
 * with itself): its matchers must pass and fail exactly where Vitest's do.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { createHarness } = createRequire(import.meta.url)('./harness.cjs');

/** Whether a matcher passes, failing the test if the harness rejects the values as unsupported. */
const passes = (assertion) => {
  try {
    assertion();

    return true;
  } catch (error) {
    if (String(error.message).startsWith('the Hermes harness')) {
      throw error;
    }

    return false;
  }
};

const sparse = (length, entries) => {
  const array = new Array(length);
  for (const [index, value] of entries) {
    array[index] = value;
  }

  return array;
};

describe('the Hermes harness', () => {
  const harness = createHarness(() => {});

  it.each([
    ['a hole and a string', sparse(1, []), ['lost text']],
    ['a string and a hole', ['lost text'], sparse(1, [])],
    ['a hole and undefined', sparse(1, []), [undefined]],
    [
      'holes in the middle',
      sparse(3, [
        [0, 'a'],
        [2, 'c'],
      ]),
      ['a', undefined, 'c'],
    ],
    ['a hole and a nested array', sparse(2, [[0, 'a']]), ['a', []]],
    ['arrays of different lengths', ['a'], ['a', undefined]],
    ['equal nested objects', { a: { b: ['x', { c: 1 }] } }, { a: { b: ['x', { c: 1 }] } }],
    ['different nested objects', { a: { b: ['x', { c: 1 }] } }, { a: { b: ['x', { c: 2 }] } }],
    ['an undefined property and a missing one', { a: 1, b: undefined }, { a: 1 }],
    ['a missing property and an undefined one', { a: 1 }, { a: 1, b: undefined }],
    ['an extra property', { a: 1 }, { a: 1, b: 2 }],
    ['NaN and NaN', NaN, NaN],
    ['NaN in arrays', [NaN], [NaN]],
    ['zero and negative zero', 0, -0],
    ['zero and negative zero in objects', { a: 0 }, { a: -0 }],
    ['null and undefined', null, undefined],
    ['an array and an object', [], {}],
    ['an array-like object and an array', { length: 0 }, []],
    ['a string and a number', '1', 1],
    ['empty arrays', [], []],
  ])('toEqual agrees with Vitest: %s', (_name, actual, expected) => {
    expect(passes(() => harness.expect(actual).toEqual(expected))).toBe(passes(() => expect(actual).toEqual(expected)));
    expect(passes(() => harness.expect([actual]).toContainEqual(expected))).toBe(
      passes(() => expect([actual]).toContainEqual(expected)),
    );
  });

  it.each([
    ['NaN', NaN, NaN],
    ['zero and negative zero', 0, -0],
    ['equal strings', 'été', 'été'],
    ['equal arrays', [], []],
  ])('toBe agrees with Vitest: %s', (_name, actual, expected) => {
    expect(passes(() => harness.expect(actual).toBe(expected))).toBe(passes(() => expect(actual).toBe(expected)));
  });

  it('rejects arrays with extra properties instead of ignoring them', () => {
    const tagged = Object.assign(['a'], { extra: 'b' });
    expect(() => harness.expect(tagged).toEqual(['a'])).toThrow('only compares arrays without extra properties');
  });

  it('rejects an async describe', () => {
    expect(() => harness.describe('later', async () => {})).toThrow('describe "later" is async');
  });

  it('fails an async test, or a test from it.each returning a promise, instead of passing it', () => {
    const lines = [];
    const own = createHarness((line) => lines.push(line));
    own.it('async', async () => {});
    own.it.each([1])('each %i', () => Promise.resolve());
    expect(() => own.run('Node')).toThrow('2 of 2 cases failed');
    expect(lines.filter((line) => line.includes('only runs synchronous tests'))).toHaveLength(2);
  });

  it('formats it.each names as Vitest does, and rejects other placeholders', () => {
    const lines = [];
    const own = createHarness((line) => lines.push(line));
    own.it.each([[7, 'été']])('seed %i, %s, 100%%', () => {});
    own.run('Node');
    expect(lines[0]).toBe('CASES ["seed 7, été, 100%"]');
    expect(() => own.it.each([1.5])('value %d', () => {})).toThrow('does not support %d');
  });
});
