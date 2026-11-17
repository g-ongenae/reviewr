# @reviewr/autosave

The autosave state machine: it sends the text being written as a document's draft, one request at a time, and says
what the editor should show (`saved`, `unsaved`, `saving`, `retrying`, `conflict`, `rejected`). Shared by the Reviewr
web and mobile apps. Framework-free on purpose: no HTTP, no React, no storage, no dependencies; runs on web, Node and
React Native (Hermes).

## Invariant

The status is `saved` only when the local text is the text of the newest confirmed draft the machine has been given.
A draft confirmed elsewhere (a read, a 409, a version save) is reconciled once no answer is pending, so nothing is called
saved while a request is in flight or a newer draft is waiting.

## Plugging in a client

```ts
import { createAutosave } from '@reviewr/autosave';

const autosave = createAutosave({
  base: { content, draftVersion }, // the server's draft the editor was opened on
  save: async (draft) => {
    // send draft.content based on draft.draftVersion; never called again before the previous call settles
    // answer { kind: 'saved', draftVersion }, { kind: 'conflict', server }, { kind: 'failed', error }
    // or { kind: 'rejected', error, permanent }; a rejected promise counts as 'failed'
  },
  debounceMs: 1000, // optional
  retryDelayMs: (attempt) => 1000 * 2 ** (attempt - 1), // optional, capped at 30 s by default
  timers: { setTimeout, clearTimeout }, // optional, defaults to the global ones
});

autosave.edit(text); // records the latest text and schedules a save
await autosave.flush(); // saves now: 'saved' | 'failed' | 'conflict' | 'rejected' | 'disposed'
autosave.resolve(merged, confirmed); // leaves a conflict with the reconciled text, based on a confirmed draft
autosave.refresh(confirmed, keepText); // a draft the server confirmed elsewhere
autosave.getSnapshot(); // the current state, the same object until something changes (useSyncExternalStore)
const unsubscribe = autosave.subscribe(listener);
autosave.dispose(); // cancels timers, ignores the answer in flight, settles pending flushes as 'disposed'
```

The package declares no DOM or Node types (`lib: ES2023`): the only host functions it uses are `setTimeout` and
`clearTimeout`, declared for its own compilation in `src/timers.d.ts`.

## Tests on Hermes

The phone runs the machine on Hermes. `pnpm --filter @reviewr/autosave test:hermes` runs the **same cases** as Vitest on
the Hermes VM React Native ships, from source and from bytecode, after a run on Node; the CI's `hermes` job does it on
every push. The tooling, its harness and its limits are described in [the merge package](../merge/README.md#tests-on-hermes).

## Developing

The apps use the built package (`dist`), not its sources. `pnpm install` and `pnpm build` build it; `pnpm dev:web` only
starts Vite. While changing the machine with an app running, keep the package rebuilding beside it:

```sh
pnpm --filter @reviewr/autosave dev
```
