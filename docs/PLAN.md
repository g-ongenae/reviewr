# reviewr — plan to v1

How we get from today's code to the v1 of the [roadmap](VISION.md#roadmap). The target design is in [ARCHITECTURE.md](ARCHITECTURE.md). This plan was reviewed by five independent critics. The decisions they changed are listed at the end.

## Where we are

- API (NestJS + Drizzle + PostgreSQL, PGlite in tests): `documents` + `revisions`. Every save is a revision. Title is required. Optimistic locking with `baseRevision`. No authentication, no owner. CORS allows no `PATCH`.
- Web (React + TanStack Query): document list, textarea editor, revision history, foldable sidebar. Home page: a blank-page `Composer` that creates a document only on Save (reload loses the text).
- Mobile (Expo): list, edit, history. Saves through `PUT /documents/:id`; "restore" immediately creates a revision (web restores into the editor instead).
- No CI. `docker-compose.yml` only runs PostgreSQL.
- None of: drafts, markup, rules, analysis, review, i18n.

## v1 definition of done

The author writes in French every day in reviewr, on their own deployed instance:
blank page → autosaved draft → named version; front matter and scopes; `sentence-length` and `repetition` with goals, shown in the editor; default and focus review with approve/flag/note. English UI, strings ready for translation. No sign-in (single user behind a private access boundary).

## Principles for the work

- **Dogfood first, then measure against real use.** The author writes in a deployed instance from the first milestone. Each later milestone is a thin vertical slice that changes what they see while writing.
- **Pure packages, tested by fixtures.** `markup` and `rules` are pure TypeScript with golden-file tests, written in step with the UI that consumes them, not months ahead of it.
- **Build tables when a feature uses them.** No table or column for v3 features (branches, merges) in v1. Linear history needs no `refs` or `merge_parent_id`; the move to commits is a mechanical mapping done when branches arrive.
- **Web first.** Mobile is maintained (drafts and versions keep working) but gets no markup, rules or review in v1.
- **Losing text is the one unacceptable bug.** Every milestone touching storage ships with tested backups and a restore rehearsal.

## Milestones

Each step is small enough to merge and use on its own.

### M0 — Use it today

- **Where it runs**: the author's home server, reachable only through Tailscale (already in place). No port is exposed outside the tailnet. Postgres is not published, has real credentials and a restart policy. (low priority, delayed, as it currently run)
- `docker-compose.yml` runs API + web + Postgres. (low priority, delayed)
- Backups: hourly `pg_dump` copied off the host, plus a plain-text export (each document's content as `.md` in a git repository). Restore tested once. (low priority, delayed)
- CI (GitHub Actions): build, typecheck, lint, test. (done)
- Quick win: a writing stats panel, shown or hidden from the toolbar: words and characters in the document, and written today (net words, characters written and deleted), measured against the last version saved before midnight. (done)

Done: the author writes on the deployed instance, from the browser and the phone.

### M1 — Drafts and named versions

Small changes on the existing schema, not the commit model:

- `documents`: `draft_content`, `draft_version` (a counter for conflict detection), `draft_base_revision`. `revisions` gets an optional `name` (the version label, separate from the document title). The migration is tested on a populated old database. (done)
- `documents`: `title` nullable, with the shared type and its display helper ("Untitled — 30 Oct", from `created_at`), used by the web and mobile apps. `revisions.title` is nullable too, and a blank title is stored as `NULL`. (done)
- `PUT /documents/:id/draft` `{ content, draftVersion }`: autosave, no revision; 409 on a stale `draftVersion`.
  - the endpoint, `Document.draft` on documents and `ReviewrClient.saveDraft` (done); a save whose text is already the stored draft is answered as saved whatever its `draftVersion`, so a retry after a lost response does not conflict with itself;
  - the 409 bodies carry a `code` (`draft_conflict` with the server's draft, `stale_revision` with the revision), read with `conflictOf` from the shared package (done);
  - the old `PUT /documents/:id` no longer overwrites an autosaved draft: it first keeps that draft as a revision, then answers 409, so builds that only know revisions see "changed elsewhere" (done);
  - the row lock tested on a real PostgreSQL with concurrent connections, in the CI (done): `saveDraft`, `createRevision` and the old `PUT` wait for the row and decide on what was committed, and races between them lose no text and duplicate no revision (the other tests run on PGlite, which runs one transaction at a time);
  - later: make `Document.draft` required in the shared type, now that the web uses it; the same tests for the rename endpoints.
- `POST /documents/:id/revisions` `{ name?, draftVersion, baseRevision }`: snapshots the draft atomically; 409 if either the draft or the head moved. Saving a draft identical to the head is a no-op.
  - the endpoint, `ReviewrClient.createRevision` and the `name` listed on revisions (done); the same request sent twice after a lost response creates one revision only;
  - later: a document without a revision yet (`baseRevision` null); decide whether a title changed alone can be saved as a version, since a draft identical to the head is a no-op.
- `PATCH /documents/:id` (title) and `PATCH /documents/:id/revisions/:n` (version name). Add `PATCH` to CORS.
  - the two endpoints, `ReviewrClient.renameDocument` and `nameRevision`, and `PATCH` in CORS (done); a rename creates no revision, the last one wins, and the next version saved from the draft takes the new title;
  - later: use them in the web and mobile apps (rename from the editor, name versions in the history). The old `PUT /documents/:id` always carries a title and applies it, so it puts an old title back when an app loaded the document before a rename: this ends for an app once it renames through `PATCH`, and stays for builds already installed.
- `POST /documents` accepts an empty draft and creates no revision: a document can exist with only a draft.
- Keep the current `PUT /documents/:id` working as "save draft + create revision" until the new mobile build ships. It keeps the draft columns equal to the saved content, and it never overwrites an autosaved draft that differs from the head: it keeps that draft as a revision first, then answers 409 (done).
- Shared types: structured 409 bodies (done: `draft_conflict` and `stale_revision`, read with `conflictOf`).

Web client — an autosave state machine, not just a debounce:

- one write in flight at a time; edits typed during a request are kept and sent next (done: the framework-free core in `apps/web/src/autosave`, with debounce, retry with backoff, `flush()` and a conflict state, tested with delayed and failed requests);
- wire the core into the editor and the Composer through `PUT /documents/:id/draft`, with a saved / saving / retrying status; tell permanent failures (a deleted document) apart from temporary ones:
  - the editor of an existing document (done): it opens on the draft and saves it as the writer types; a document left before its text was saved keeps being saved in the background; a deleted document stops the saves for good and a refused text (too large) waits for a change, both with the text left on screen; a newer draft read from the server while the writer has unsaved text is a conflict, never a silent replacement; "Save version" flushes the draft, then creates the version through the old `PUT /documents/:id`;
  - a draft conflict shows a temporary banner in the editor (discard my text, or keep it and save the other text as a version first), until the reconciliation view is opened there;
  - later: the Composer; "Save version" through `POST /documents/:id/revisions`; the title saved by a rename instead of "Save version"; offer to save the text as a new document when the document was deleted;
- the Composer creates the document on the first autosave with an idempotency key (retry-safe), and does not lose keystrokes typed while it is being created;
- local buffer in IndexedDB, restored after a crash or a failed request; it also keeps the base (server draft and `draftVersion` the edits started from):
  - the storage module `apps/web/src/autosave/localBuffer.ts`: writes land in call order, a delete can be conditional on the confirmed text, it never throws into the editor, and its schema is versioned for the outbox (done);
  - use it from the editor and the Composer: write on every edit, delete once the server confirmed the save, restore on start; when the buffer answers a failure (unavailable, full, stalled), tell the writer the local copy is not being kept, and never reload or discard the text in memory;
  - two tabs editing the same document share one entry, so the buffer keeps only the text written last: give each tab its own entry or a lock;
- offline mode: an unreachable server (network error, 502/503/504) shows a "Server unreachable" notification, never a blocking error; edits and versions go to an outbox and are sent on reconnect;
- reconciliation view when both sides moved: three-way word merge of base, mine and theirs, non-overlapping changes applied, conflicts resolved by the writer (mine, theirs, both, edit), the losing side kept as a named version (see [ARCHITECTURE.md](ARCHITECTURE.md#offline-and-reconciliation)):
  - the merge itself: the pure `@reviewr/merge` package, where overlapping, adjacent and ambiguous changes (repeated text) are conflicts (done);
  - the view, built on the package: the standalone component in `apps/web/src/reconcile/` (done), with each change attributed to its side, conflicts resolved by mine, theirs, both or a hand edit ("keep both" opens the hand edit on the two texts joined as they are, so the writer adds the separator), nothing applied before the writer confirms, and a hand edit never dropped when the other side moves again;
  - later: open the view from the editor on a draft conflict, and save its result against the server's `draftVersion`;
  - keep the local text as a named version before every reconciliation, not only for conflicts: a few ambiguous merges can still be silent (listed in `packages/merge/README.md`), in particular when one side changed more than about 1,000 words;
  - run the package's tests on a real Hermes runtime (only the Hermes compiler was checked);
- flush before "Save version", navigation, `beforeunload` and tab hide (done for every document with unsaved text, including one already left; closing the page can still cut the last request short, until the local buffer is used there);
- tests with delayed responses, failed requests, typing during creation, and offline edits reconciled against a moved server draft.

Mobile: switch to the draft and revision endpoints; restore goes into the editor as on the web. Same offline outbox (SQLite) and the same merge package; the phone is where offline writing happens most.

Done: e2e tests for draft conflicts, version creation and the migration on a populated old database; merge fixtures (French prose, overlapping and adjacent edits, deletions on one side); a day written offline on the phone reconciles with edits made on the web.

### M2 — First ruler: sentences and one rule

The thinnest slice from text to feedback:

- `@reviewr/markup` v0: Markdown (remark) → prose segments with a **source map** (UTF-16, half-open offsets; prose is not a contiguous slice of the source once markup, escapes and emphasis are removed). Code, HTML, headings and URLs are excluded from prose.
- Sentence segmentation: `Intl.Segmenter` plus a French post-pass (no break inside `« … »`, closing `»` and dialogue dashes attached, abbreviations like `M.`, `Mme`, `p. ex.`, `c.-à-d.`, ellipsis followed by a lowercase letter continues the sentence, U+00A0/U+202F as spaces). Per-language data, French first.
- One tokenizer for every rule: `’` → `'`, hyphenated compounds are one word, case-insensitive, accent-sensitive.
- `sentence-length` as a display-only rule.
- Web editor moves to CodeMirror 6 (still plain text). Sentence lengths shown as decorations and in a side panel.
- An analysis identity is versioned from the start: parser, segmenter, locale and rule versions.
- Tests: golden fixtures (French typography, CRLF, emoji, links, entities), source-map property tests, segmentation fixtures run on Chromium, Firefox and WebKit, and a performance budget on a 100k-word text (decides whether a Web Worker is needed).

Done: the author sees sentence lengths on their real French texts. Then two weeks of use before M3; note what is missing.

### M3 — Goals and repetition

Write the goal spec first (half a page in ARCHITECTURE), then code:

- **Per unit vs per scope.** A bare `range`, `exactly` or comparison applies to every unit and gives one finding per unit that misses it. `mean`, `median` and `stddev` apply to the scope.
- **`min` and `max` are directional.** They show the value and never pass or fail.
- **Small samples.** 0 units: "no text". `stddev` needs at least 3 units (sample stddev); below the minimum the result is "insufficient", with no warning.
- **Rules declare how they aggregate** (`sum` for counts, `mean` for lengths), so the shared evaluator knows which number a scope-level goal reads. Options are validated; invalid options are a front-matter diagnostic.
- `repetition`: same word within a window of N words (configurable), minimum word length, built-in `fr` and `en` stop-word lists (without them the rule flags `de`, `la`, `que` everywhere). The v1 rules need no language data beyond these lists; they are not equally meaningful in every language.
- Front matter: `lang` and global `rules`. Front matter exists only if line 1 is `---` and a closing `---` exists; otherwise it is body text with a diagnostic. Invalid YAML never blocks parsing of the body.

Done: the author sets goals in front matter and sees them evaluated.

### M4 — Scopes

- Block scopes (`@@@name`, bare `@@@`) and inline scopes (`@name: text`, `@name:` + next line). Markers are recognised only at column 0 of top-level paragraphs, never inside code, HTML, quotes or lists. `@name:` needs a name matching `[A-Za-z][\w-]*` followed by a space or end of line; anything else (`@alex`, `@alex:bonjour`) is text. `\@` is the escape.
- Scope resolution: global → `extends` (recursive, ordered) → own rules, `global: false`, `off`; each resolved rule carries its origin. Diagnostics: unknown scope, cycle, more than one `default`, `default` outside the front matter.
- Aggregation across all passages of a scope; repetition counts only the tokens of the scope it evaluates. A sentence belongs to the scope of its first character.
- Side panel grouped by scope, with the resolved rules and their origin. Markup highlighted in the editor. Preview tab with the markup stripped.
- **Spans** (`[text]{@scope lang=de}`) last, as a micromark extension: a span only when `{` follows `]` directly and `]` closes no link. If they prove hard, they move to v1.1 without blocking the release.

### M5 — Review (default and focus)

- **Review targets a version.** "Start review" saves a version first if the draft differs from the head (auto-named "Review — 30 Oct"), so the reviewed text is stable without asking the writer to do anything.
- `annotations` table and API (`approve`, `flag`, `note`): text-quote anchor + `sentence_hash` + the analysis identity of M2. Ambiguous matches (the same sentence twice) do not carry an approval forward; they need a new review.
- Default mode: the sentence in the centre, the surrounding lines, its scope and rule results. Focus mode: the sentence only. Keyboard first (j/k, a/f/n/e). Progress: "142/310 sentences approved in this version".
- "Edit inline" applies the change to the current draft, rebased by quote; if the sentence has changed in the draft since, the edit opens the editor at that place instead.
- Then: carrying approvals forward to later versions.

Done: the author reviews a full chapter in focus mode.

### M6 — v1 release

- UI strings extracted (i18n library on the web). Until then, the rule is: no strings built by concatenation in JSX.
- README, ARCHITECTURE and VISION updated; tag v1.

## Order and parallelism

M0 → M1 is serial (storage). M2's `markup` and segmentation work can start during M1. M3 and M4 depend on M2. M5 needs M2 (sentences) and versions from M1, not M3 or M4, so a stateless review page (sentences one by one, no annotations) can be shown as early as M2 if the author wants it.

## After v1

1. Commits, blobs and refs (mapping each revision to a commit), then branches, merges, prose diffs, blame (v3 per the roadmap).
2. Local target: API with persistent PGlite (production code is wired to `pg` today; spike it before promising it).
3. Lenses and the rich view (sentence-length first).
4. Mobile catches up (Hermes has no `Intl.Segmenter`: polyfill or server analysis).
5. Server analysis endpoint + cache, needed by the first heavy rule. `rules-fr`: syllables, vocabulary lists.
6. Projects, exports and data API, UI translations, plugin API, trunslutur as a review plugin.

## Risks

| Risk                                                       | Mitigation                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Losing text (autosave, migration, deploy)                  | Client buffer, serialized writes, hourly off-host backups, restore rehearsal |
| Losing text in a bad reconciliation                        | Deterministic merge with fixtures; losing side always kept as a version      |
| Exposing an unauthenticated API                            | Tailscale only, from M0                                                      |
| `Intl.Segmenter` differs between engines, and gets updated | Cross-browser fixtures; analysis identity stored with every approval         |
| Markers or spans collide with Markdown                     | Markers only in top-level paragraphs; spans last and deferrable              |
| Offsets drift between Markdown, markup and the segmenter   | One source-map model with property tests                                     |
| Rules become noise in French                               | Stop-word lists and French segmentation fixtures from the start              |
| Tests on PGlite, production on PostgreSQL 18               | Run conflict and locking tests against real PostgreSQL in CI                 |

## Changes to the architecture this plan implies

- Linear history stays on `revisions` (with draft and version name) in v1; `blobs`, `commits` and `refs` arrive with branches. The migration note ("the current content becomes … `head_commit_id`") also needs fixing: the head points to the migrated latest commit.
- Parsing is Markdown-aware with a source map; retext/parse-latin is replaced by `Intl.Segmenter` plus per-language post-processing.
- Goals: per-unit vs per-scope, directional `min`/`max`, `aggregate` on rules. The `mom` example (`exactly: 1` "per sentence") becomes `{ mean: '=1' }` or stays per unit, by the new rule.
- Review always targets a version, created on demand.
- Lenses and the local target move to v2.

## Decisions

- Access: Tailscale only (already set up). A public URL with accounts waits for v3.
- Hosting: the author's home server (already running). Off-host backups matter all the more.
- History: v1 keeps linear `revisions`; `blobs`, `commits` and `refs` arrive with branches in v3.
