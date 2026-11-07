<img src="assets/icon.svg" width="64" height="64" alt="">

# reviewr

An IDE for stories: a ruler, not an intelligence. See the [vision](docs/VISION.md) and the [architecture](docs/ARCHITECTURE.md).

For now: write texts, save them, and get them back, on the web and on Android. Every save keeps a revision.

## Layout

pnpm workspace monorepo:

| Path              | What                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `apps/api`        | REST API: NestJS 12 on Fastify, PostgreSQL via Drizzle ORM               |
| `apps/web`        | Website: React 19 + Vite, TanStack Query                                 |
| `apps/mobile`     | Android app: Expo SDK 58 (React Native), Expo Router                     |
| `packages/shared` | API types, validation limits and typed HTTP client, used by all the apps |

## Getting started

Requirements: Node ≥ 24, pnpm, Docker (for PostgreSQL).

```bash
pnpm install                     # also builds packages/shared
pnpm db:up                       # PostgreSQL 18 on localhost:5432
cp apps/api/.env.example apps/api/.env

pnpm dev:api                     # http://localhost:3000 (applies migrations on boot)
pnpm dev:web                     # http://localhost:5173 (proxies /api to the API)
pnpm dev:mobile                  # Expo dev server; press "a" for the Android emulator
```

The mobile app calls port 3000 on the machine running the Expo dev server, which works for both the emulator and a phone on the same network. Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to override it.

If you change `packages/shared`, rebuild it with `pnpm --filter @reviewr/shared build`, or keep `pnpm --filter @reviewr/shared dev` running.

## Checks

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

API tests are end-to-end: they run the real Nest app against an in-process PostgreSQL ([PGlite](https://pglite.dev)), so Docker isn't needed. `packages/shared` tests the HTTP client's error classification, and the web app tests its components in jsdom with `fetch` stubbed.

## Data model

- `documents`: the current state (`title`, `content`, `revision` counter) so reads don't need a join.
- `revisions`: an append-only snapshot `(document_id, revision)` written on every save that changes something. Saving identical content is a no-op.

Saves use optimistic locking. `PUT` sends the `baseRevision` the edit started from. If the document was saved elsewhere in the meantime (another tab or the phone), the API answers **409** instead of overwriting. The apps then offer to discard the local changes or to keep them as a new revision.

After changing `apps/api/src/database/schema.ts`, generate a migration with `pnpm --filter @reviewr/api db:generate`.

## REST API

| Method   | Path                                 | Body                               | Response                           |
| -------- | ------------------------------------ | ---------------------------------- | ---------------------------------- |
| `GET`    | `/health`                            |                                    | `{ status: 'ok' }`                 |
| `GET`    | `/documents`                         |                                    | `DocumentSummary[]`                |
| `POST`   | `/documents`                         | `{ title, content }`               | `201 Document`                     |
| `GET`    | `/documents/:id`                     |                                    | `Document`                         |
| `PUT`    | `/documents/:id`                     | `{ title, content, baseRevision }` | `Document` / `409`                 |
| `DELETE` | `/documents/:id`                     |                                    | `204`                              |
| `GET`    | `/documents/:id/revisions`           |                                    | `RevisionSummary[]` (newest first) |
| `GET`    | `/documents/:id/revisions/:revision` |                                    | `Revision`                         |

The types are defined in `packages/shared/src/types.ts`. Titles are limited to 200 characters and content to 1,000,000.

There is no authentication yet: all documents are shared by everyone who can reach the API.
