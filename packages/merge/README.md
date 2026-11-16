# @reviewr/merge

Pure, deterministic three-way word merge used to reconcile a draft edited offline (`mine`) with the server's draft
(`theirs`), both started from the same `base`. No dependencies, no I/O; runs on web and React Native (Hermes).

```ts
import { mergeWords, resolveMerge } from '@reviewr/merge';

const result = mergeWords(base, mine, theirs);
// result.parts: unchanged | mine | theirs | both | conflict, in order; non-overlapping changes already applied.
// One resolution per conflict, in order: 'mine', 'theirs', 'both' or { edit: 'hand-written text' }.
const text = resolveMerge(result, resolutions);
```

## Rules

- Texts are compared token by token: words (with inner apostrophes and hyphens: `aujourd’hui`, `dit-il`), runs of
  spaces (including U+00A0 and U+202F), line breaks (`\r\n` is one) and punctuation marks or emoji. Joining the tokens
  gives the text back exactly.
- Paragraphs are compared first, then the words inside the paragraphs that changed, so a long chapter stays fast.
- A change made by one side is applied; the same change made by both is applied once.
- Overlapping changes are a conflict. So are **adjacent** ones: changes that touch, insertions at the same place, and
  changes only separated by spaces on the same line (`la fenêtre` → `une fenêtre` and `la porte` is a conflict, not
  `une porte`). Changes separated by punctuation, a line break or another word merge cleanly.
- Over repeated text, the alignment of a side with the base can be ambiguous. Each side is aligned with the base twice,
  over all its tokens: the shortest alignment preferring the earliest of equal matches, and the one preferring the
  latest. A base token both keep, as the same token of that side, is an anchor. For the conflict test, a change covers
  all the base text between the anchors around it, so every token that either alignment changes counts. Deleting one
  of two identical sentences `Elle attend.` while the other side changes the first into `Elle part.` is a conflict,
  even when the deletion is part of a larger change or the copies are on separate lines. The same deletion still
  merges cleanly with a change elsewhere. A conflict region is still where the earliest alignment placed the changes,
  so "keep both" never repeats the shared text.
- What can still merge silently:
  - a third, equally short alignment that both of these keep apart (none found, but not ruled out);
  - a reading of a side that takes more edits than the shortest one: base `Oui, Oui, Oui fin.`, mine
    `Oui, Oui, Oui, Ensuite.`, theirs `Non, Oui, Oui fin.` gives `Non, Oui, Oui, Ensuite.`, although mine may have
    added the first copy;
  - a side that changed more than 2,000 tokens in all (about 1,000 words): its alignments are then computed paragraph
    by paragraph, and tokens are never matched across an unchanged line. Base `Avant. Oui.\nOui.\nAprès.`, mine
    deleting a `Oui.` line and adding 1,100 words at the end, theirs `Avant. Si.\nOui.\nAprès.` merges silently.
- A conflict is resolved with `'mine'`, `'theirs'`, `'both'` (mine then theirs, exactly as written) or `{ edit }`.

## Tests on Hermes

The phone runs JavaScript on Hermes, whose regular expressions, strings and sorting are not V8's. `pnpm test` runs the
specs on Node with Vitest; `pnpm --filter @reviewr/merge test:hermes` runs the **same cases** on the Hermes VM that
React Native ships (the CI's `hermes` job does it on every push), three times:

1. on Node, to check the harness itself;
2. on Hermes from source, as in a development build;
3. on Hermes from bytecode compiled by `hermesc -O`, as in a release build.

How: `hermes/run.mjs` asks `vitest list` for the spec files and the names of their cases, transpiles each file of `src`
with TypeScript (target ES2023, as the package's build), wraps it as a CommonJS module and bundles it with
`hermes/harness.cjs`, a small stand-in for Vitest: what the merge and autosave specs use, nothing more. A run passes
only if every case passed and its case names are exactly Vitest's; a spec file outside `src` or not in TypeScript fails
the script. Each failure is printed with its name. `hermes/harness.spec.mjs`, run by `pnpm test`, checks the harness
against Vitest: its matchers on the same values (sparse arrays, extra array keys and symbols, nested objects,
`undefined`, `NaN`, `-0`, subsets), its hooks' order, and its fake timers on the same scenarios, which must record the
same order of timers and promises with both. It and `hermes/lockfile.spec.mjs` test this tooling and are the only specs
not run on Hermes. No spec of `src` is left out.

Tests may be asynchronous. The fake timers follow Vitest's (@sinonjs/fake-timers): `advanceTimersByTimeAsync` waits
for a task of the host, so that every pending microtask runs, before the first timer and after each one. The Hermes CLI
has such tasks: its `setTimeout` ignores the delay and runs its tasks in order, each after all microtasks. A test that
never settles, or that leaves a rejected promise unhandled (Node's `unhandledRejection`, Hermes' rejection tracker),
fails, as it fails Vitest's run.

Limits, each failing loudly rather than passing: hooks are synchronous and inside a `describe`, `describe` is
synchronous, a test may only wait for promises and the fake timers (not real ones), only `setTimeout(callback, ms)` and
`clearTimeout` are faked (`setInterval` and `setImmediate` throw while faked), `vi.useRealTimers()` with fake timers
still pending is an error (Vitest drops them), and specs may import only `vitest` and relative files. `Date` is not
faked, unlike Vitest's; no machine or spec reads it. Vitest's 5 s timeout is not applied. What runs is a CommonJS
transform of the sources, not Metro's bundle of the built package: it covers the engine, not the app's bundler.

The binaries: `hermes/hermes.env` holds the one definition of the version, used by both scripts and the CI cache key.
React Native 0.88.0 uses Hermes `260318099.0.4` (its `hermes-compiler` dependency), from the tag
`hermes-v260318099.0.4` of facebook/hermes. `run.mjs` follows `pnpm-lock.yaml` from the `apps/mobile` importer to its
resolved `react-native`, then to that snapshot's `hermes-compiler`, and fails if a link is missing or the version is
not the pin (after a React Native upgrade), saying how to update it. `hermes/lockfile.mjs` reads the lockfile strictly
(no YAML library is installed here) and fails on any YAML it does not recognise. That release publishes no standalone VM for Linux (npm
has the compiler only, Maven the iOS and Android libraries), so `hermes/get-hermes.sh` builds `hermes` and `hermesc`
from the tag's source tarball, pinned by commit and checked by SHA-256, with `Intl` on as React Native builds it, into
`.hermes/` (ignored by git). It needs cmake, ninja, a C++ compiler and the ICU headers
(`sudo apt-get install cmake ninja-build libicu-dev`); a few minutes on 4 cores.

```sh
packages/merge/hermes/get-hermes.sh   # once
pnpm --filter @reviewr/merge test:hermes
pnpm --filter @reviewr/autosave test:hermes   # node ../merge/hermes/run.mjs .
```

How this VM differs from the phone's: same engine, version and bytecode compiler, but

- `Intl`, `String.prototype.normalize`, `localeCompare` and the `toLocale…` methods use ICU here (the version of the
  runner's system), where Android uses Java's (`java.text`, `android.icu`) and iOS Apple's Foundation: locale data and
  edge cases can differ. The package calls none of them; one spec uses `normalize` to build its input;
- regular expressions (`\p{…}` included), case mapping of plain strings, string iteration and sorting use Hermes' own
  code and Unicode tables on every platform: those are what the tokenizer relies on;
- release build without the debugger, so no difference in results, but no inspector either;
- the timing cases run on the CI runner's CPU, not a phone's;
- the host is the Hermes CLI, not React Native: its task queue, which only the harness uses, is not the app's event
  loop. The autosave specs fake the timers, so the machine's timers never reach either;
- the bundle is compiled with `-Xes6-block-scoping`, off by default at this tag: without it, Hermes gives `let` and
  `const` the scope of their function, and a closure made in a loop sees the last iteration's value. On the phone,
  Metro's Babel preset lowers block scoping before Hermes sees the code; the harness checks the scoping before running.
  Neither raises an error for a `let` read before its declaration (V8 does);
- an unhandled rejection is reported by Hermes' tracker only if still unhandled when its check runs (on the fake clock
  while the timers are faked); Node reports one handled late too. The run on Node catches those.

Another package can use it as `@reviewr/autosave` does: a `test:hermes` script running `node ../merge/hermes/run.mjs .`,
and a step in the CI's `hermes` job. `run.mjs` takes the package's directory; the binaries and bundles stay in
`packages/merge/.hermes`, so one build and one cache serve every package.
