/*
 * The part of Vitest the specs use, small enough to run in the Hermes VM: `describe`, `it`, `it.each` and `expect` with
 * `toBe`, `toEqual`, `toContainEqual`, `toBeGreaterThan`, `toBeLessThan` and `toThrow`. Anything else is missing on
 * purpose, so a spec that starts using it fails here instead of passing for the wrong reason.
 *
 * Tests are collected first, as Vitest does, then `run` executes them in order, prints each failure with its full name,
 * and throws at the end if any failed: the VM then exits with a non-zero status.
 */
const log = typeof print === 'function' ? print : console.log;
const tests = [];
const prefixes = [];

const describe = (name, body) => {
  prefixes.push(name);
  try {
    body();
  } finally {
    prefixes.pop();
  }
};

const it = (name, body) => {
  tests.push({ name: [...prefixes, name].join(' > '), body });
};

/** Vitest's `%s`, `%i`, `%d` and `%%` placeholders, filled in order. */
const format = (template, values) => {
  let index = 0;

  return template.replace(/%([sid%])/g, (match, letter) => {
    if (letter === '%') {
      return '%';
    }
    const value = values[index++];

    return letter === 's' ? String(value) : String(Math.trunc(Number(value)));
  });
};

it.each = (table) => (template, body) => {
  for (const row of table) {
    const values = Array.isArray(row) ? row : [row];
    it(format(template, values), () => body(...values));
  }
};

/** Vitest's `toEqual`: recursive equality, where a property set to `undefined` equals a missing one. */
const equals = (a, b) => {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equals(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) {
    throw new Error('the Hermes harness only compares plain objects and arrays');
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  return [...keys].every((key) => equals(a[key], b[key]));
};

const show = (value) => (typeof value === 'function' ? value.name : JSON.stringify(value));

const expect = (actual) => {
  const check = (pass, message) => {
    if (!pass) {
      throw new Error(message);
    }
  };

  return {
    toBe: (expected) => check(Object.is(actual, expected), `expected ${show(actual)} to be ${show(expected)}`),
    toEqual: (expected) => check(equals(actual, expected), `expected ${show(actual)} to equal ${show(expected)}`),
    toContainEqual: (expected) =>
      check(
        actual.some((item) => equals(item, expected)),
        `expected ${show(actual)} to contain ${show(expected)}`,
      ),
    toBeGreaterThan: (bound) => check(actual > bound, `expected ${show(actual)} to be greater than ${show(bound)}`),
    toBeLessThan: (bound) => check(actual < bound, `expected ${show(actual)} to be less than ${show(bound)}`),
    toThrow: (type) => {
      if (type !== undefined && typeof type !== 'function') {
        throw new Error('the Hermes harness only supports toThrow() and toThrow(ErrorClass)');
      }
      try {
        actual();
      } catch (error) {
        check(type === undefined || error instanceof type, `expected a ${show(type)}, got ${String(error)}`);

        return;
      }
      check(false, `expected the function to throw${type === undefined ? '' : ` a ${show(type)}`}`);
    },
  };
};

const run = (engine) => {
  let failed = 0;
  for (const test of tests) {
    try {
      test.body();
    } catch (error) {
      failed++;
      log(`FAIL ${test.name}\n     ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`${engine}: ${tests.length - failed} passed, ${failed} failed, ${tests.length} cases`);
  if (failed > 0 || tests.length === 0) {
    throw new Error(`${failed} of ${tests.length} cases failed on ${engine}`);
  }
};

module.exports = { describe, expect, it, run };
