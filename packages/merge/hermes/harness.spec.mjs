/*
 * The Hermes harness against Vitest itself, run by `pnpm test` (not on Hermes, where it would only compare the harness
 * with itself): its matchers must pass and fail exactly where Vitest's do, its fake timers must run timers and settle
 * promises in the same order as Vitest's, and its hooks must run in the same order.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harnessPath = createRequire(import.meta.url).resolve('./harness.cjs');
const { createHarness } = createRequire(import.meta.url)(harnessPath);

/** The same hooks and tests, declared with Vitest or with the harness: each records its order in `log`. */
const declareHooks = (api, log) => {
  api.describe('hooks', () => {
    api.beforeEach(() => {
      log.push('outer before 1');
    });
    api.afterEach(() => {
      log.push('outer after 1');
    });
    api.it('first', () => {
      log.push('first');
    });
    api.describe('inner', () => {
      api.beforeEach(() => {
        log.push('inner before');
      });
      api.afterEach(() => {
        log.push('inner after');
      });
      api.it('second', () => {
        log.push('second');
      });
    });
    // Declared after the tests, still run for them.
    api.afterEach(() => {
      log.push('outer after 2');
    });
    api.beforeEach(() => {
      log.push('outer before 2');
    });
  });
};
const vitestHookOrder = [];
declareHooks({ describe, it, beforeEach, afterEach }, vitestHookOrder);

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

  /** Whether a matcher passes, counting the harness's refusal of unsupported values as a failure. */
  const passesOrRefuses = (assertion) => {
    try {
      assertion();

      return true;
    } catch {
      return false;
    }
  };
  const symbol = Symbol('extra');

  it.each([
    ['a named property on an array', Object.assign(['a'], { extra: 'lost' }), ['a']],
    ['a negative key on an array', Object.assign(['a'], { '-1': 'lost' }), ['a']],
    ['a fractional key on an array', Object.assign(['a', 'b'], { 0.5: 'lost' }), ['a', 'b']],
    ['a key with a leading zero on an array', Object.assign(['a', 'b'], { '01': 'lost' }), ['a', 'b']],
    ['a symbol on an array', Object.assign(['a'], { [symbol]: 'lost' }), ['a']],
    ['a symbol on an object', { a: 1, [symbol]: 'lost' }, { a: 1 }],
  ])('fails, as Vitest does, on %s, in both directions', (_name, extra, plain) => {
    for (const [actual, expected] of [
      [extra, plain],
      [plain, extra],
    ]) {
      expect(passes(() => expect(actual).toEqual(expected))).toBe(false);
      expect(passes(() => expect([actual]).toContainEqual(expected))).toBe(false);
      expect(passesOrRefuses(() => harness.expect(actual).toEqual(expected))).toBe(false);
      expect(passesOrRefuses(() => harness.expect([actual]).toContainEqual(expected))).toBe(false);
    }
  });

  it('refuses extra array properties and symbols instead of ignoring them', () => {
    expect(() => harness.expect(Object.assign(['a'], { '-1': 'lost' })).toEqual(['a'])).toThrow(
      'only compares arrays without extra properties',
    );
    expect(() => harness.expect({ [symbol]: 1 }).toEqual({})).toThrow('without symbol properties');
  });

  it('rejects an async describe', () => {
    expect(() => harness.describe('later', async () => {})).toThrow('describe "later" is async');
  });

  it('formats it.each names as Vitest does, and rejects other placeholders', async () => {
    const lines = [];
    const own = createHarness((line) => lines.push(line));
    own.it.each([[7, 'été']])('seed %i, %s, 100%%', () => {});
    await own.run('Node');
    expect(lines[0]).toBe('CASES ["seed 7, été, 100%"]');
    expect(() => own.it.each([1.5])('value %d', () => {})).toThrow('does not support %d');
  });
});

/** Whether a matcher passes, awaiting it if it returns a promise; the harness refusing the values counts as failing. */
const passesAsync = async (assertion) => {
  try {
    await assertion();

    return true;
  } catch {
    return false;
  }
};

/**
 * Scenarios run once with Vitest's `vi` and `expect`, once with the harness's: both must record `expected`. They cover
 * what the autosave specs rely on: the order timers fire in, the microtasks that run between two timers, timers set or
 * cleared while advancing, a timer that throws, a promise settled the way the specs answer a request, and `vi.fn`.
 */
const scenarios = [
  [
    'timers fire by due time, then in the order they were set',
    async ({ vi }, log) => {
      setTimeout(() => log.push('a at 300'), 300);
      setTimeout(() => log.push('b at 100'), 100);
      setTimeout(() => log.push('c at 100'), 100);
      setTimeout(() => log.push('d at 0'), 0);
      clearTimeout(setTimeout(() => log.push('cleared'), 50));
      for (const ms of [0, 99, 1, 1000]) {
        await vi.advanceTimersByTimeAsync(ms);
        log.push(`advanced ${ms}`);
      }
    },
    ['d at 0', 'advanced 0', 'advanced 99', 'b at 100', 'c at 100', 'advanced 1', 'a at 300', 'advanced 1000'],
  ],
  [
    'every microtask runs before advancing starts, and between two timers',
    async ({ vi }, log) => {
      const chain = (label, length) => {
        let promise = Promise.resolve();
        for (let i = 1; i <= length; i++) {
          promise = promise.then(() => i === length && log.push(`${label}: microtask ${i}`));
        }
      };
      const awaits = async (label) => {
        for (let i = 0; i < 5; i++) {
          await null;
        }
        log.push(`${label}: after 5 awaits`);
      };
      chain('queued before advancing', 30);
      setTimeout(() => {
        log.push('first');
        chain('first', 50);
        void awaits('first');
      }, 10);
      setTimeout(() => log.push('second'), 10);
      setTimeout(() => {
        log.push('third');
        chain('third', 50);
      }, 20);
      await vi.advanceTimersByTimeAsync(20);
      log.push('advanced 20');
    },
    [
      'queued before advancing: microtask 30',
      'first',
      'first: after 5 awaits',
      'first: microtask 50',
      'second',
      'third',
      'third: microtask 50',
      'advanced 20',
    ],
  ],
  [
    'timers set while advancing run if due in time, 0 ms counting as 1',
    async ({ vi }, log) => {
      setTimeout(() => {
        log.push('at 50');
        setTimeout(() => log.push('at 51: 0 ms, set while advancing'), 0);
        setTimeout(() => log.push('at 150'), 100);
        void Promise.resolve().then(() => setTimeout(() => log.push('at 60: set by a microtask'), 10));
      }, 50);
      setTimeout(() => {
        log.push('at 100');
        setTimeout(() => log.push('at 101'), 0);
      }, 100);
      for (const ms of [100, 1, 49]) {
        await vi.advanceTimersByTimeAsync(ms);
        log.push(`advanced ${ms}`);
      }
      setTimeout(() => log.push('0 ms, set before advancing'), 0);
      await vi.advanceTimersByTimeAsync(0);
      log.push('advanced 0');
    },
    [
      'at 50',
      'at 51: 0 ms, set while advancing',
      'at 60: set by a microtask',
      'at 100',
      'advanced 100',
      'at 101',
      'advanced 1',
      'at 150',
      'advanced 49',
      '0 ms, set before advancing',
      'advanced 0',
    ],
  ],
  [
    'a timer that throws rejects the advance with the first error, after the other timers ran',
    async ({ vi }, log) => {
      setTimeout(() => {
        log.push('throws first');
        throw new Error('first');
      }, 10);
      setTimeout(() => {
        log.push('throws second');
        throw new Error('second');
      }, 20);
      setTimeout(() => log.push('still runs'), 30);
      setTimeout(() => log.push('at 60'), 60);
      await vi.advanceTimersByTimeAsync(50).then(
        () => log.push('resolved'),
        (error) => log.push(`rejected: ${error.message}`),
      );
      // The clock is at 50, not at 30 where the last timer ran: 9 ms more do not reach 60, the next one does.
      await vi.advanceTimersByTimeAsync(9);
      log.push('advanced 9');
      await vi.advanceTimersByTimeAsync(1);
      log.push('advanced 1');
    },
    ['throws first', 'throws second', 'still runs', 'rejected: first', 'advanced 9', 'at 60', 'advanced 1'],
  ],
  [
    'a handle kept from before vi.useRealTimers() does not clear a timer set after the next vi.useFakeTimers()',
    async ({ vi }, log) => {
      const stale = setTimeout(() => log.push('stale'), 500);
      clearTimeout(stale);
      vi.useRealTimers();
      vi.useFakeTimers();
      setTimeout(() => log.push('saved'), 500);
      clearTimeout(stale);
      await vi.advanceTimersByTimeAsync(500);
    },
    ['saved'],
  ],
  [
    'a timer or a microtask between two timers clears a timer due at the same time',
    async ({ vi }, log) => {
      const timers = {};
      setTimeout(() => {
        log.push('a clears b, its microtask c');
        clearTimeout(timers.b);
        void Promise.resolve().then(() => clearTimeout(timers.c));
      }, 10);
      timers.b = setTimeout(() => log.push('b'), 10);
      timers.c = setTimeout(() => log.push('c'), 10);
      setTimeout(() => log.push('d'), 10);
      await vi.advanceTimersByTimeAsync(10);
      log.push('advanced 10');
    },
    ['a clears b, its microtask c', 'd', 'advanced 10'],
  ],
  [
    'a request answered as the autosave specs do: resolve, then advance by 0',
    async ({ vi }, log) => {
      let answer;
      const request = async () => {
        log.push('sent');
        const result = await new Promise((resolve) => {
          answer = resolve;
        });
        log.push(`got ${result}`);
        await null;
        setTimeout(() => log.push('timer set by the answer'), 0);
        log.push('continuation done');
      };
      setTimeout(() => void request(), 500);
      for (const ms of [499, 1]) {
        await vi.advanceTimersByTimeAsync(ms);
        log.push(`advanced ${ms}`);
      }
      answer('saved');
      log.push('answered');
      await vi.advanceTimersByTimeAsync(0);
      log.push('advanced 0');
      let outcome;
      void Promise.resolve('flushed').then((value) => (outcome = value));
      log.push(`outcome ${outcome}`);
      await vi.advanceTimersByTimeAsync(0);
      log.push(`outcome ${outcome}`);
    },
    [
      'advanced 499',
      'sent',
      'advanced 1',
      'answered',
      'got saved',
      'continuation done',
      'timer set by the answer',
      'advanced 0',
      'outcome undefined',
      'outcome flushed',
    ],
  ],
  [
    'vi.fn records every call, one that throws included, until mockClear',
    async ({ vi, expect }, log) => {
      const check = async (label, assertion) => log.push(`${label}: ${await passesAsync(assertion)}`);
      const plain = vi.fn();
      const doubled = vi.fn((value) => value * 2);
      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      await check('not called yet', () => expect(plain).not.toHaveBeenCalled());
      await check('called 0 times', () => expect(plain).toHaveBeenCalledTimes(0));
      log.push(`returns ${plain('a')} and ${doubled(21)}`);
      try {
        throwing();
      } catch (error) {
        log.push(`throws ${error.message}`);
      }
      for (const [label, mock] of Object.entries({ plain, doubled, throwing })) {
        await check(`${label} called once`, () => expect(mock).toHaveBeenCalledTimes(1));
      }
      await check('not called, after a call', () => expect(plain).not.toHaveBeenCalled());
      await check('called twice', () => expect(plain).toHaveBeenCalledTimes(2));
      log.push(`mockClear returns the mock: ${plain.mockClear() === plain}`);
      await check('not called, after mockClear', () => expect(plain).not.toHaveBeenCalled());
      plain();
      await check('called once, after mockClear', () => expect(plain).toHaveBeenCalledTimes(1));
    },
    [
      'not called yet: true',
      'called 0 times: true',
      'returns undefined and 42',
      'throws boom',
      'plain called once: true',
      'doubled called once: true',
      'throwing called once: true',
      'not called, after a call: false',
      'called twice: false',
      'mockClear returns the mock: true',
      'not called, after mockClear: true',
      'called once, after mockClear: true',
    ],
  ],
];

describe('the Hermes harness, asynchronous', () => {
  /** Runs a scenario on fake timers, and returns what it recorded. */
  const record = async (api, scenario) => {
    const log = [];
    api.vi.useFakeTimers();
    try {
      await scenario(api, log);
    } finally {
      api.vi.useRealTimers();
    }

    return log;
  };

  it.each(scenarios)('records what Vitest records: %s', async (_name, scenario, expected) => {
    expect(await record({ vi, expect }, scenario)).toEqual(expected);
    expect(
      await record(
        createHarness(() => {}),
        scenario,
      ),
    ).toEqual(expected);
  });

  const harness = createHarness(() => {});
  const error = new Error('502');

  it.each([
    ['a subset', { a: 1, b: 2 }, { a: 1 }],
    ['a nested subset', { a: { b: 1, c: 2 }, d: 3 }, { a: { b: 1 } }],
    ['an empty subset', { a: 1 }, {}],
    ['another value', { a: 1 }, { a: 2 }],
    ['a missing key', { a: 1 }, { b: 1 }],
    ['a missing key expected undefined', { a: 1 }, { a: 1, b: undefined }],
    ['an undefined key expected undefined', { a: 1, b: undefined }, { b: undefined }],
    ['an extra key expected in a nested object', { a: { b: 1 } }, { a: { b: 1, c: 2 } }],
    ['arrays of subsets', { a: [{ b: 1, c: 2 }] }, { a: [{ b: 1 }] }],
    ['arrays of different lengths', { a: [1, 2] }, { a: [1] }],
    ['an object and an array', { a: {} }, { a: [] }],
    ['null and an empty object', { a: null }, { a: {} }],
    ['a number and an empty object', { a: 5 }, { a: {} }],
    ['a missing key and an empty object', {}, { a: {} }],
    ['null and an object with keys', { a: null }, { a: { b: undefined } }],
    ['a string and an object with its keys', { a: 'abc' }, { a: { length: 3 } }],
    ['the same error', { status: 'retrying', error }, { error }],
    ['zero and negative zero', { a: 0 }, { a: -0 }],
    ['NaN and NaN', { a: NaN }, { a: NaN }],
    ['top-level arrays of subsets', [{ a: 1, b: 2 }], [{ a: 1 }]],
  ])('toMatchObject agrees with Vitest: %s', (_name, actual, expected) => {
    expect(passes(() => harness.expect(actual).toMatchObject(expected))).toBe(
      passes(() => expect(actual).toMatchObject(expected)),
    );
  });

  it.each([
    ['toHaveLength, the same length', (e) => e([1, 2]).toHaveLength(2)],
    ['toHaveLength, another length', (e) => e([1, 2]).toHaveLength(3)],
    ['toHaveLength, an empty array', (e) => e([]).toHaveLength(0)],
    ['toBeUndefined, undefined', (e) => e(undefined).toBeUndefined()],
    ['toBeUndefined, null', (e) => e(null).toBeUndefined()],
    ['toBeLessThanOrEqual, equal', (e) => e(1).toBeLessThanOrEqual(1)],
    ['toBeLessThanOrEqual, greater', (e) => e(2).toBeLessThanOrEqual(1)],
    ['toBeLessThanOrEqual, NaN', (e) => e(NaN).toBeLessThanOrEqual(1)],
    ['not.toBe, the same string', (e) => e('a').not.toBe('a')],
    ['not.toBe, equal objects', (e) => e({}).not.toBe({})],
    ['not.toBe, zero and negative zero', (e) => e(0).not.toBe(-0)],
    ['not.toThrow, a function that returns', (e) => e(() => 1).not.toThrow()],
    [
      'not.toThrow, a function that throws',
      (e) =>
        e(() => {
          throw new Error('boom');
        }).not.toThrow(),
    ],
  ])('agrees with Vitest: %s', (_name, assertion) => {
    expect(passes(() => assertion(harness.expect))).toBe(passes(() => assertion(expect)));
  });

  it.each([
    ['resolving to the value', () => Promise.resolve('saved'), 'saved'],
    ['resolving to another value', () => Promise.resolve('failed'), 'saved'],
    ['resolving after a task', () => new Promise((resolve) => setImmediate(() => resolve('saved'))), 'saved'],
    ['rejecting', () => Promise.reject(new Error('saved')), 'saved'],
    ['resolving to an equal object', () => Promise.resolve({}), {}],
  ])('resolves.toBe agrees with Vitest on a promise %s', async (_name, promise, expected) => {
    expect(await passesAsync(() => harness.expect(promise()).resolves.toBe(expected))).toBe(
      await passesAsync(() => expect(promise()).resolves.toBe(expected)),
    );
  });

  it('runs async tests to the end, and fails one that rejects, throws after an await, never settles or leaves a failing assertion', async () => {
    const lines = [];
    const own = createHarness((line) => lines.push(line));
    const log = [];
    own.it('passes after awaits and fake timers', async () => {
      own.vi.useFakeTimers();
      await null;
      await own.vi.advanceTimersByTimeAsync(1000);
      own.vi.useRealTimers();
      log.push('passed');
    });
    own.it('fails after an await', async () => {
      await null;
      own.expect(1).toBe(2);
      log.push('not reached');
    });
    own.it('rejects', () => Promise.reject(new Error('lost text')));
    own.it('throws before its first await', async () => {
      throw new Error('at once');
    });
    own.it('never settles', () => new Promise(() => {}));
    own.it('awaits a failing resolves', async () => {
      await own.expect(Promise.resolve('failed')).resolves.toBe('saved');
    });
    // As Vitest, which waits for the asynchronous assertions of a test before it passes, awaited or not.
    own.it('does not await a passing resolves', () => {
      void own.expect(Promise.resolve('saved')).resolves.toBe('saved');
      log.push('not awaited');
    });
    own.it('does not await a failing resolves', () => {
      void own.expect(Promise.resolve('failed')).resolves.toBe('saved');
    });
    own.it('does not await a resolves that never settles', () => {
      void own.expect(new Promise(() => {})).resolves.toBe('saved');
    });
    own.it('runs after them', () => {
      log.push('ran');
    });
    await expect(own.run('Node')).rejects.toThrow('7 of 10 cases failed on Node');
    expect(lines.filter((line) => line.startsWith('FAIL'))).toEqual([
      'FAIL fails after an await\n     expected 1 to be 2',
      'FAIL rejects\n     lost text',
      'FAIL throws before its first await\n     at once',
      'FAIL never settles\n     the test never settles',
      'FAIL awaits a failing resolves\n     expected the promise to resolve to "saved", got "failed"',
      'FAIL does not await a failing resolves\n     expected the promise to resolve to "saved", got "failed"',
      'FAIL does not await a resolves that never settles\n     an asynchronous assertion never settles',
    ]);
    expect(log).toEqual(['passed', 'not awaited', 'ran']);
  });

  it('owns every asynchronous assertion of a test: made in a hook, made late, or handled by the test', async () => {
    const lines = [];
    const own = createHarness((line) => lines.push(line));
    const lost = () => void own.expect(Promise.resolve('lost')).resolves.toBe('saved');
    own.describe('a failing assertion in beforeEach', () => {
      own.beforeEach(lost);
      own.it('fails the test', () => {});
    });
    own.describe('a failing assertion in afterEach', () => {
      own.afterEach(lost);
      own.it('fails the test', () => {});
    });
    own.describe('an assertion that never settles in beforeEach', () => {
      own.beforeEach(() => void own.expect(new Promise(() => {})).resolves.toBe('saved'));
      own.it('fails the test', () => {});
    });
    own.it('fails with an assertion made after the body returned', () => {
      let chain = Promise.resolve();
      for (let i = 0; i < 20; i++) {
        chain = chain.then(() => {});
      }
      void chain.then(lost);
    });
    own.it('fails with an assertion made after the others settled', () => {
      void own
        .expect(Promise.resolve('saved'))
        .resolves.toBe('saved')
        .then(() => Promise.resolve())
        .then(lost);
    });
    own.it('fails once when the test awaits the failure', async () => {
      await own.expect(Promise.resolve('lost')).resolves.toBe('saved');
    });
    // As Vitest: a failure the test handled is the test's business.
    own.it('passes when the test handles the failure', async () => {
      await own
        .expect(Promise.resolve('lost'))
        .resolves.toBe('saved')
        .catch(() => {});
    });
    own.it('passes after them: their assertions are not counted for it', () => {});
    await expect(own.run('Node')).rejects.toThrow('6 of 8 cases failed on Node');
    const failure = 'expected the promise to resolve to "saved", got "lost"';
    expect(lines.filter((line) => line.startsWith('FAIL'))).toEqual([
      `FAIL a failing assertion in beforeEach > fails the test\n     ${failure}`,
      `FAIL a failing assertion in afterEach > fails the test\n     ${failure}`,
      'FAIL an assertion that never settles in beforeEach > fails the test\n     an asynchronous assertion never settles',
      `FAIL fails with an assertion made after the body returned\n     ${failure}`,
      `FAIL fails with an assertion made after the others settled\n     ${failure}`,
      `FAIL fails once when the test awaits the failure\n     ${failure}`,
    ]);
  });

  it('runs beforeEach and afterEach in the order Vitest does', async () => {
    const order = [];
    const own = createHarness(() => {});
    declareHooks(own, order);
    await own.run('Node');
    expect(order).toEqual(vitestHookOrder);
    expect(order).toEqual([
      ...['outer before 1', 'outer before 2', 'first', 'outer after 2', 'outer after 1'],
      ...[
        'outer before 1',
        'outer before 2',
        'inner before',
        'second',
        'inner after',
        'outer after 2',
        'outer after 1',
      ],
    ]);
  });

  it("handles a failing hook as Vitest's runner does: the rest is skipped, the afterEach hooks run anyway", async () => {
    const lines = [];
    const own = createHarness((line) => lines.push(line));
    const log = [];
    const failing = { before: 'before fails', after: 'after fails' };
    own.describe('outer', () => {
      own.beforeEach(() => {
        log.push('outer before');
      });
      own.afterEach(() => {
        log.push('outer after');
      });
      for (const [step, test] of [
        ['before', 'skipped'],
        ['test', 'test fails'],
        ['after', 'test passes'],
      ]) {
        own.describe(step, () => {
          own.beforeEach(() => {
            if (step === 'before') {
              throw new Error(failing.before);
            }
          });
          own.afterEach(() => {
            log.push(`${step}: inner after`);
            if (step === 'after') {
              throw new Error(failing.after);
            }
          });
          own.it(test, () => {
            log.push(test);
            if (step === 'test') {
              throw new Error(test);
            }
          });
        });
      }
    });
    await expect(own.run('Node')).rejects.toThrow('3 of 3 cases failed');
    expect(log).toEqual([
      ...['outer before', 'before: inner after', 'outer after'],
      ...['outer before', 'test fails', 'test: inner after', 'outer after'],
      ...['outer before', 'test passes', 'after: inner after'],
    ]);
    expect(lines.filter((line) => line.startsWith('FAIL'))).toEqual([
      'FAIL outer > before > skipped\n     before fails',
      'FAIL outer > test > test fails\n     test fails',
      'FAIL outer > after > test passes\n     after fails',
    ]);
  });

  it('refuses what it does not support instead of ignoring it', async () => {
    const realTimers = [globalThis.setTimeout, globalThis.setInterval];
    const own = createHarness(() => {});
    expect(() => own.beforeEach(() => {})).toThrow('only supports beforeEach inside a describe');
    // Vitest passes it: an expected object only needs its keys, which an array may have.
    expect(() => own.expect({ a: [] }).toMatchObject({ a: {} })).toThrow('only matches an array against an array');
    const lines = [];
    const hooks = createHarness((line) => lines.push(line));
    hooks.describe('async hooks', () => {
      hooks.beforeEach(async () => {});
      hooks.it('test', () => {});
    });
    await expect(hooks.run('Node')).rejects.toThrow('1 of 1 cases failed');
    expect(lines[0]).toContain('only runs synchronous hooks');

    // Like Vitest, advancing needs fake timers.
    await expect(vi.advanceTimersByTimeAsync(1)).rejects.toThrow();
    await expect(own.vi.advanceTimersByTimeAsync(1)).rejects.toThrow('the timers are not faked');

    own.vi.useFakeTimers();
    try {
      expect(() => own.vi.useFakeTimers()).toThrow('once until vi.useRealTimers()');
      expect(() => setTimeout(() => {}, 1.5)).toThrow('only fakes setTimeout(callback, ms)');
      expect(() => setTimeout(() => {}, 1, 'argument')).toThrow('only fakes setTimeout(callback, ms)');
      expect(() => setInterval(() => {}, 1)).toThrow('does not fake setInterval');
      const first = own.vi.advanceTimersByTimeAsync(1);
      await expect(own.vi.advanceTimersByTimeAsync(1)).rejects.toThrow('does not advance the timers twice');
      await first;
      setTimeout(() => {}, 1);
    } finally {
      expect(() => own.vi.useRealTimers()).toThrow('with 1 fake timers pending');
    }
    expect([globalThis.setTimeout, globalThis.setInterval]).toEqual(realTimers);
  });

  it('fails a test that leaves a rejection unhandled, and exits with a non-zero status when a case fails', () => {
    const runChild = (tests) =>
      spawnSync(
        process.execPath,
        ['-e', `const { describe, it, run } = require(${JSON.stringify(harnessPath)});\n${tests}\nrun('Node');`],
        { encoding: 'utf8' },
      );
    const failing = runChild(`describe('d', () => {
      it('leaves a rejection unhandled', () => { Promise.reject(new Error('lost text')); });
      it('passes', () => {});
    });`);
    expect(failing.stdout).toContain(
      'FAIL d > leaves a rejection unhandled\n     unhandled rejection: Error: lost text',
    );
    expect(failing.stdout).toContain('Node: 1 passed, 1 failed, 2 cases');
    expect(failing.status).not.toBe(0);
    const passing = runChild(`it('passes', async () => { await null; });`);
    expect(passing.stdout).toContain('Node: 1 passed, 0 failed, 1 cases');
    expect(passing.status).toBe(0);
  });
});
