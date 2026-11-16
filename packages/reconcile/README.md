# @reviewr/reconcile

What a client needs to reconcile a draft conflict, without React or the DOM. Shared by the Reviewr web and mobile apps.

- `reconcile.ts`: the model of the reconciliation view. It merges base, mine and theirs with `@reviewr/merge`, records
  the writer's choice for each conflict, carries the choices over when a side changes, and gives the reconciled text
  once nothing is left to resolve.
- `session.ts`: the reconciliation session of one document. It keeps every text a result would erase as a version,
  then applies the result through the autosave machine (`@reviewr/autosave`).

## The session's rule

Before a result is applied, every text the session was given (each local text and each other device's text) is the
result itself or verifiably kept as a version. A text counts as kept only when the session saw it as the head, or got a
success for a snapshot of it; never because the server's draft happens to hold it. No request overwrites a draft that
is not kept.

The package declares no DOM, Node or React types (`lib: ES2023`). `session.ts` names versions with
`Intl.DateTimeFormat`.

## Developing

The apps use the built package (`dist`), not its sources. `pnpm install` and `pnpm build` build it; `pnpm dev:web` only
starts Vite. While changing the reconciliation with an app running, keep the package rebuilding beside it:

```sh
pnpm --filter @reviewr/reconcile dev
```
