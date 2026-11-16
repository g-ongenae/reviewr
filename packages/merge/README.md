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
`hermes/harness.cjs`, a small stand-in for Vitest (`describe`, `it`, `it.each` with `%s` and `%i`, `expect` with
`toBe`, `toEqual`, `toContainEqual`, `toBeGreaterThan`, `toBeLessThan`, `toThrow`). A run passes only if every case
passed and its case names are exactly Vitest's; a spec file outside `src` or not in TypeScript fails the script. Each
failure is printed with its name. `hermes/harness.spec.mjs`, run by `pnpm test`, checks the harness's matchers against
Vitest's (sparse arrays, nested objects, `undefined`, `NaN`, `-0`); it is the one spec not run on Hermes. No spec of
`src` is left out.

Limits, each failing loudly rather than passing: tests must be synchronous (a `describe` or a test that returns a
promise is an error), and specs may import only `vitest` and relative files. What runs is a CommonJS transform of the
sources, not Metro's bundle of the built package: it covers the engine, not the app's bundler.

The binaries: `hermes/hermes.env` holds the one definition of the version, used by both scripts and the CI cache key.
React Native 0.88.0 uses Hermes `260318099.0.4` (its `hermes-compiler` dependency), from the tag
`hermes-v260318099.0.4` of facebook/hermes. `run.mjs` fails if `pnpm-lock.yaml` resolves another `hermes-compiler`
(after a React Native upgrade), and says how to update the pin. That release publishes no standalone VM for Linux (npm
has the compiler only, Maven the iOS and Android libraries), so `hermes/get-hermes.sh` builds `hermes` and `hermesc`
from the tag's source tarball, pinned by commit and checked by SHA-256, with `Intl` on as React Native builds it, into
`.hermes/` (ignored by git). It needs cmake, ninja, a C++ compiler and the ICU headers
(`sudo apt-get install cmake ninja-build libicu-dev`); a few minutes on 4 cores.

```sh
packages/merge/hermes/get-hermes.sh   # once
pnpm --filter @reviewr/merge test:hermes
```

How this VM differs from the phone's: same engine, version and bytecode compiler, but

- `Intl`, `String.prototype.normalize`, `localeCompare` and the `toLocale…` methods use ICU here (the version of the
  runner's system), where Android uses Java's (`java.text`, `android.icu`) and iOS Apple's Foundation: locale data and
  edge cases can differ. The package calls none of them; one spec uses `normalize` to build its input;
- regular expressions (`\p{…}` included), case mapping of plain strings, string iteration and sorting use Hermes' own
  code and Unicode tables on every platform: those are what the tokenizer relies on;
- release build without the debugger, so no difference in results, but no inspector either;
- the timing cases run on the CI runner's CPU, not a phone's.

Another package can reuse this: `run.mjs` bundles any `src` whose specs import only `vitest` and relative files, and
needs only its paths to be set from the package it runs for (move `hermes/` to a shared place then).
