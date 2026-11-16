/*
 * The part of Vitest the specs use, small enough to run in the Hermes VM: `describe`, `it`, `it.each` (`%s`, `%i`,
 * `%%`) and `expect` with `toBe`, `toEqual`, `toContainEqual`, `toBeGreaterThan`, `toBeLessThan` and `toThrow`. Tests
 * are synchronous. Anything else is missing or rejected on purpose, so a spec that starts using it fails here instead
 * of passing for the wrong reason. `harness.spec.mjs` checks it against Vitest.
 *
 * Tests are collected first, as Vitest does, then `run` executes them in order, prints each failure with its full name,
 * prints the names of all cases (for run.mjs to compare with Vitest's), and throws at the end if any failed: the VM then
 * exits with a non-zero status.
 */
const isThenable = (value) =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof value.then === 'function';

/** Vitest's `%s`, `%i` and `%%` placeholders, filled in order. */
const format = (template, values) => {
  let index = 0;

  return template.replace(/%(.)/g, (match, letter) => {
    if (letter === '%') {
      return '%';
    }
    if (letter !== 's' && letter !== 'i') {
      throw new Error(`the Hermes harness does not support %${letter} in test names`);
    }
    const value = values[index++];

    return letter === 's' ? String(value) : String(Number.parseInt(String(value), 10));
  });
};

/** Whether an array has only index properties, so comparing its indexes compares all of it. */
const isPlainArray = (array) =>
  Object.getPrototypeOf(array) === Array.prototype &&
  Object.keys(array).every((key) => String(Number(key)) === key && Number(key) < array.length);

/** Vitest's `toEqual`: recursive equality, where `undefined`, a missing property and an array hole are the same. */
const equals = (a, b) => {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    if (!isPlainArray(a) || !isPlainArray(b)) {
      throw new Error('the Hermes harness only compares arrays without extra properties');
    }
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i], b[i])) {
        return false;
      }
    }

    return true;
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

/** A fresh collector: the specs use the default one, harness.spec.mjs makes its own. */
const createHarness = (log) => {
  const tests = [];
  const prefixes = [];

  const describe = (name, body) => {
    prefixes.push(name);
    try {
      if (isThenable(body())) {
        throw new Error(`describe "${name}" is async: the Hermes harness only runs synchronous specs`);
      }
    } finally {
      prefixes.pop();
    }
  };

  const it = (name, body) => {
    tests.push({ name: [...prefixes, name].join(' > '), body });
  };

  it.each = (table) => (template, body) => {
    for (const row of table) {
      const values = Array.isArray(row) ? row : [row];
      it(format(template, values), () => body(...values));
    }
  };

  const run = (engine) => {
    let failed = 0;
    for (const test of tests) {
      try {
        if (isThenable(test.body())) {
          throw new Error('the test is async: the Hermes harness only runs synchronous tests');
        }
      } catch (error) {
        failed++;
        log(`FAIL ${test.name}\n     ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`CASES ${JSON.stringify(tests.map((test) => test.name))}`);
    log(`${engine}: ${tests.length - failed} passed, ${failed} failed, ${tests.length} cases`);
    if (failed > 0 || tests.length === 0) {
      throw new Error(`${failed} of ${tests.length} cases failed on ${engine}`);
    }
  };

  return { describe, expect, it, run };
};

module.exports = { ...createHarness(typeof print === 'function' ? print : console.log), createHarness };
