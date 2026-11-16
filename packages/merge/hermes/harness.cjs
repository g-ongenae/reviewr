/*
 * The part of Vitest the specs use, small enough to run in the Hermes VM: `describe`, `it`, `it.each` (`%s`, `%i`,
 * `%%`), synchronous `beforeEach` and `afterEach` inside a `describe`, tests that may return a promise, `vi.fn`, the
 * fake `setTimeout` and `clearTimeout` of `vi.useFakeTimers` with `vi.advanceTimersByTimeAsync`, and `expect` with the
 * matchers listed in `expect` below. Anything else is missing or rejected on purpose, so a spec that starts using it
 * fails here instead of passing for the wrong reason. `harness.spec.mjs` checks it against Vitest.
 *
 * Tests are collected first, as Vitest does, then `run` executes them in order, prints each failure with its full name,
 * prints the names of all cases (for run.mjs to compare with Vitest's), and fails at the end if any failed: the error is
 * thrown from a task of the host, so that the VM exits with a non-zero status (Hermes only does so for a task).
 */
const isThenable = (value) =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof value.then === 'function';

/**
 * Queues a task on the host, taken before a spec can fake the timers: Node's `setImmediate`, or the `setTimeout` of the
 * Hermes CLI, which ignores its delay and runs its tasks in order. Both run every microtask before the next task, which
 * is what Vitest's fake timers (@sinonjs/fake-timers) rely on to let promises settle between two timers.
 */
const hostTask = typeof setImmediate === 'function' ? setImmediate : setTimeout;
let pendingHostTasks = 0;
/** A promise resolved by the next task of the host, once all the microtasks queued before it have run. */
const nextTask = () =>
  new Promise((resolve) => {
    pendingHostTasks++;
    hostTask(() => {
      pendingHostTasks--;
      resolve();
    });
  });

/** Calls `listener` with the reason of each rejected promise nobody handles; returns a function that stops it. */
const watchUnhandledRejections = (listener) => {
  if (typeof process === 'object' && typeof process.on === 'function') {
    process.on('unhandledRejection', listener);

    return () => process.off('unhandledRejection', listener);
  }
  if (typeof HermesInternal === 'object' && typeof HermesInternal.enablePromiseRejectionTracker === 'function') {
    // Hermes' Promise reports it from a setTimeout task (the fake one while the timers are faked, see useRealTimers).
    HermesInternal.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, reason) => listener(reason),
      onHandled: () => {},
    });

    return () => {};
  }
  throw new Error('the Hermes harness cannot see unhandled rejections on this engine');
};

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
  !hasEnumerableSymbol(array) &&
  Object.keys(array).every((key) => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < array.length);

/** Whether a value has enumerable symbol properties, which the harness does not compare. */
const hasEnumerableSymbol = (value) =>
  Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol));

/** Refuses what the harness does not compare: arrays with extra keys, objects that are not plain, symbol keys. */
const checkComparable = (value) => {
  if (Array.isArray(value)) {
    if (!isPlainArray(value)) {
      throw new Error('the Hermes harness only compares arrays without extra properties');
    }

    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('the Hermes harness only compares plain objects and arrays');
  }
  if (hasEnumerableSymbol(value)) {
    throw new Error('the Hermes harness only compares objects without symbol properties');
  }
};

/**
 * Vitest's `toEqual`: recursive equality, where `undefined`, a missing property and an array hole are the same. With
 * `subset`, Vitest's `toMatchObject`: an expected object only needs its own keys to be own keys of the value, with
 * matching values (an expected `{}` matches anything, even `null`), and arrays still need the same length, their items
 * compared the same way.
 */
const equals = (a, b, subset = false) => {
  if (Object.is(a, b)) {
    return true;
  }
  if (subset && typeof b === 'object' && b !== null && !Array.isArray(b)) {
    checkComparable(b);
    const isObject = typeof a === 'object' && a !== null;
    if (isObject && Array.isArray(a)) {
      throw new Error('the Hermes harness only matches an array against an array');
    }
    if (isObject) {
      checkComparable(a);
    }

    return Object.keys(b).every(
      (key) => isObject && Object.prototype.hasOwnProperty.call(a, key) && equals(a[key], b[key], true),
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  checkComparable(a);
  checkComparable(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i], b[i], subset)) {
        return false;
      }
    }

    return true;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  return [...keys].every((key) => equals(a[key], b[key]));
};

const show = (value) => (typeof value === 'function' ? value.name : JSON.stringify(value));

/** The calls of each function made by `vi.fn`, for `toHaveBeenCalledTimes` and `not.toHaveBeenCalled`. */
const mockCalls = new WeakMap();

const expect = (actual) => {
  const check = (pass, message) => {
    if (!pass) {
      throw new Error(message);
    }
  };
  const isNumber = (value) => typeof value === 'number';
  const calls = () => {
    if (!mockCalls.has(actual)) {
      throw new Error('the Hermes harness only counts the calls of a vi.fn()');
    }

    return mockCalls.get(actual).length;
  };
  /** What `actual()` throws, as `{ error }`, or undefined if it returns. */
  const thrown = () => {
    try {
      actual();
    } catch (error) {
      return { error };
    }

    return undefined;
  };

  return {
    toBe: (expected) => check(Object.is(actual, expected), `expected ${show(actual)} to be ${show(expected)}`),
    toEqual: (expected) => check(equals(actual, expected), `expected ${show(actual)} to equal ${show(expected)}`),
    toMatchObject: (expected) => {
      if ([actual, expected].some((value) => typeof value !== 'object' || value === null)) {
        throw new Error('the Hermes harness only matches an object against an object');
      }
      check(equals(actual, expected, true), `expected ${show(actual)} to match ${show(expected)}`);
    },
    toContainEqual: (expected) =>
      check(
        actual.some((item) => equals(item, expected)),
        `expected ${show(actual)} to contain ${show(expected)}`,
      ),
    toHaveLength: (length) => {
      if (!Array.isArray(actual) || !isNumber(length)) {
        throw new Error('the Hermes harness only checks the length of an array');
      }
      check(actual.length === length, `expected ${show(actual)} to have length ${length}`);
    },
    toBeUndefined: () => check(actual === undefined, `expected ${show(actual)} to be undefined`),
    toBeGreaterThan: (bound) => check(actual > bound, `expected ${show(actual)} to be greater than ${show(bound)}`),
    toBeLessThan: (bound) => check(actual < bound, `expected ${show(actual)} to be less than ${show(bound)}`),
    toBeLessThanOrEqual: (bound) => {
      if (!isNumber(actual) || !isNumber(bound)) {
        throw new Error('the Hermes harness only compares numbers');
      }
      check(actual <= bound, `expected ${show(actual)} to be less than or equal to ${show(bound)}`);
    },
    toThrow: (type) => {
      if (type !== undefined && typeof type !== 'function') {
        throw new Error('the Hermes harness only supports toThrow() and toThrow(ErrorClass)');
      }
      const result = thrown();
      check(result !== undefined, `expected the function to throw${type === undefined ? '' : ` a ${show(type)}`}`);
      check(
        type === undefined || result.error instanceof type,
        `expected a ${show(type)}, got ${String(result.error)}`,
      );
    },
    toHaveBeenCalledTimes: (times) => check(calls() === times, `expected ${times} calls, got ${calls()}`),
    not: {
      toBe: (expected) => check(!Object.is(actual, expected), `expected ${show(actual)} not to be ${show(expected)}`),
      toHaveBeenCalled: (...rest) => {
        if (rest.length > 0) {
          throw new Error('the Hermes harness only supports not.toHaveBeenCalled()');
        }
        check(calls() === 0, `expected no call, got ${calls()}`);
      },
      toThrow: (...rest) => {
        if (rest.length > 0) {
          throw new Error('the Hermes harness only supports not.toThrow()');
        }
        const result = thrown();
        check(result === undefined, `expected the function not to throw, got ${String(result?.error)}`);
      },
    },
    resolves: {
      toBe: async (expected) => {
        if (!isThenable(actual)) {
          throw new Error('the Hermes harness only supports resolves on a promise');
        }
        let value;
        try {
          value = await actual;
        } catch (error) {
          throw new Error(`expected the promise to resolve, it rejected with ${String(error)}`);
        }
        check(Object.is(value, expected), `expected the promise to resolve to ${show(expected)}, got ${show(value)}`);
      },
    },
  };
};

/** A fake clock for `setTimeout` and `clearTimeout`, run as @sinonjs/fake-timers does for Vitest. */
const createClock = () => {
  let now = 0;
  let nextId = 1;
  let advancing = false;
  let busy = false;
  const timers = new Map();

  const setTimeout = (callback, delay, ...rest) => {
    if (typeof callback !== 'function') {
      throw new TypeError('the callback of setTimeout must be a function');
    }
    if (rest.length > 0 || !Number.isInteger(delay) || delay < 0 || delay > 2 ** 31 - 1) {
      throw new Error('the Hermes harness only fakes setTimeout(callback, ms), ms a whole number from 0 to 2^31 - 1');
    }
    const id = nextId++;
    // As fake-timers: a timer of 0 ms set while advancing is due 1 ms later, so that it cannot run forever.
    timers.set(id, { id, at: now + (delay === 0 && advancing ? 1 : delay), callback });

    return id;
  };

  const clearTimeout = (id) => {
    timers.delete(id);
  };

  /** The timer due first by `to`: the earliest, then the first set. */
  const firstDue = (to) => {
    let first;
    for (const timer of timers.values()) {
      if (
        timer.at <= to &&
        (first === undefined || timer.at < first.at || (timer.at === first.at && timer.id < first.id))
      ) {
        first = timer;
      }
    }

    return first;
  };

  /**
   * fake-timers' `tickAsync`: waits for a task of the host, then runs each timer due within `ms`, in order, waiting for
   * a task of the host after each one, so the promises it settled run before the next timer. Timers set meanwhile run
   * too if they are due in time. A timer that throws does not stop the others: the first error rejects at the end.
   */
  const advance = async (ms) => {
    if (!Number.isInteger(ms) || ms < 0) {
      throw new Error('the Hermes harness only advances the timers by a whole number of ms, 0 or more');
    }
    if (busy) {
      throw new Error('the Hermes harness does not advance the timers twice at the same time');
    }
    busy = true;
    const errors = [];
    let to;
    try {
      await nextTask();
      advancing = true;
      to = now + ms;
      for (let timer = firstDue(to); timer !== undefined; timer = firstDue(to)) {
        timers.delete(timer.id);
        now = timer.at;
        try {
          timer.callback();
        } catch (error) {
          errors.push(error);
        }
        await nextTask();
      }
    } finally {
      advancing = false;
      busy = false;
    }
    now = to;
    if (errors.length > 0) {
      throw errors[0];
    }
  };

  return { setTimeout, clearTimeout, advance, pending: () => timers.size };
};

/**
 * Host functions Vitest fakes too, but the harness does not: while the timers are faked, calling them throws. `Date` is
 * not faked either, unlike Vitest's: neither the machine nor the specs read the clock.
 */
const notFaked = ['setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'];

const createVi = () => {
  let clock;
  let saved = [];

  const fn = (implementation) => {
    if (implementation !== undefined && typeof implementation !== 'function') {
      throw new Error('the Hermes harness only supports vi.fn() and vi.fn(implementation)');
    }
    const calls = [];
    // Records the call before running it, so a call that throws counts too, as in Vitest.
    const mock = function (...args) {
      calls.push(args);

      return implementation === undefined ? undefined : implementation.apply(this, args);
    };
    mock.mockClear = () => {
      calls.length = 0;

      return mock;
    };
    mockCalls.set(mock, calls);

    return mock;
  };

  const useFakeTimers = (...rest) => {
    if (rest.length > 0 || clock !== undefined) {
      throw new Error('the Hermes harness only supports vi.useFakeTimers(), once until vi.useRealTimers()');
    }
    clock = createClock();
    const replacements = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    for (const name of notFaked) {
      replacements[name] = () => {
        throw new Error(`the Hermes harness does not fake ${name}`);
      };
    }
    saved = Object.keys(replacements).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    for (const [name, value] of Object.entries(replacements)) {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
    }
  };

  const useRealTimers = () => {
    if (clock === undefined) {
      return;
    }
    const pending = clock.pending();
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) {
        delete globalThis[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
    clock = undefined;
    // Vitest drops them. Refused here: on Hermes, the report of an unhandled rejection may be one of them.
    if (pending > 0) {
      throw new Error(`vi.useRealTimers() with ${pending} fake timers pending: the Hermes harness does not drop them`);
    }
  };

  const advanceTimersByTimeAsync = async (ms) => {
    if (clock === undefined) {
      throw new Error('the timers are not faked: call vi.useFakeTimers() first');
    }
    await clock.advance(ms);
  };

  return { fn, useFakeTimers, useRealTimers, advanceTimersByTimeAsync };
};

/**
 * Waits for what a test or a hook returned. A promise still pending when the host has no task left that the harness
 * queued can never settle (Vitest would fail it after its timeout): it fails.
 */
const settle = async (value) => {
  if (!isThenable(value)) {
    return;
  }
  let settled = false;
  const done = () => {
    settled = true;
  };
  value.then(done, done);
  while (!settled) {
    await nextTask();
    if (!settled && pendingHostTasks === 0) {
      throw new Error('the test never settles');
    }
  }
  await value;
};

/** A fresh collector: the specs use the default one, harness.spec.mjs makes its own. */
const createHarness = (log) => {
  const tests = [];
  const suites = [];

  const describe = (name, body) => {
    suites.push({ name, beforeEach: [], afterEach: [] });
    try {
      if (isThenable(body())) {
        throw new Error(`describe "${name}" is async: the Hermes harness only collects synchronous describes`);
      }
    } finally {
      suites.pop();
    }
  };

  const hook = (kind) => (body) => {
    if (suites.length === 0) {
      throw new Error(`the Hermes harness only supports ${kind} inside a describe`);
    }
    suites.at(-1)[kind].push(body);
  };

  const it = (name, body) => {
    tests.push({ name: [...suites.map((suite) => suite.name), name].join(' > '), body, suites: [...suites] });
  };

  it.each = (table) => (template, body) => {
    for (const row of table) {
      const values = Array.isArray(row) ? row : [row];
      it(format(template, values), () => body(...values));
    }
  };

  const callHook = (body, kind) => {
    if (body() !== undefined) {
      throw new Error(`a ${kind} hook returned something: the Hermes harness only runs synchronous hooks`);
    }
  };

  /** Runs the tests; resolves if all passed, rejects otherwise. */
  const run = async (engine) => {
    // What advanceTimersByTimeAsync relies on: the host runs all microtasks, however many, before its next task.
    let drained = false;
    void Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        drained = true;
      });
    await nextTask();
    if (!drained) {
      throw new Error(`${engine} runs a task before the microtasks queued earlier: the Hermes harness cannot run here`);
    }
    // What the specs rely on, as any code: each iteration of a loop has its own `let` (see -Xes6-block-scoping, run.mjs).
    const iterations = [];
    for (let i = 0; i < 2; i++) {
      iterations.push(() => i);
    }
    if (iterations[0]() !== 0) {
      throw new Error(
        `${engine} shares one \`let\` between the iterations of a loop: compile with -Xes6-block-scoping`,
      );
    }

    const unhandled = [];
    const stopWatching = watchUnhandledRejections((reason) => unhandled.push(reason));
    let failed = 0;
    try {
      for (const test of tests) {
        const errors = [];
        // As Vitest: outer hooks first before, last after, the afterEach hooks of a describe in reverse order; a
        // failing beforeEach skips the rest and the test, the afterEach hooks run anyway.
        const beforeEach = test.suites.flatMap((suite) => suite.beforeEach);
        const afterEach = [...test.suites].reverse().flatMap((suite) => [...suite.afterEach].reverse());
        try {
          for (const body of beforeEach) {
            callHook(body, 'beforeEach');
          }
          await settle(test.body());
        } catch (error) {
          errors.push(error);
        }
        try {
          for (const body of afterEach) {
            callHook(body, 'afterEach');
          }
        } catch (error) {
          errors.push(error);
        }
        // Lets the engine report the rejections left unhandled by this test.
        await nextTask();
        errors.push(...unhandled.splice(0).map((reason) => new Error(`unhandled rejection: ${String(reason)}`)));
        if (errors.length > 0) {
          failed++;
          const messages = errors.map((error) => (error instanceof Error ? error.message : String(error)));
          log(`FAIL ${test.name}\n     ${messages.join('\n     ')}`);
        }
      }
    } finally {
      stopWatching();
    }
    log(`CASES ${JSON.stringify(tests.map((test) => test.name))}`);
    log(`${engine}: ${tests.length - failed} passed, ${failed} failed, ${tests.length} cases`);
    if (failed > 0 || tests.length === 0) {
      throw new Error(`${failed} of ${tests.length} cases failed on ${engine}`);
    }
  };

  return {
    describe,
    it,
    beforeEach: hook('beforeEach'),
    afterEach: hook('afterEach'),
    expect,
    vi: createVi(),
    run,
  };
};

const harness = createHarness(typeof print === 'function' ? print : console.log);

module.exports = {
  ...harness,
  // Thrown from a task: an error thrown from a microtask leaves the Hermes CLI's exit status at 0.
  run: (engine) =>
    harness.run(engine).catch((error) =>
      hostTask(() => {
        throw error;
      }),
    ),
  createHarness,
};
