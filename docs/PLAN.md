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
  - a document without a revision yet (done): the base is `null` or 0, the first version is revision 1, and an empty draft is a no-op; later: decide whether a title changed alone can be saved as a version, since a draft identical to the head is a no-op.
- `PATCH /documents/:id` (title) and `PATCH /documents/:id/revisions/:n` (version name). Add `PATCH` to CORS.
  - the two endpoints, `ReviewrClient.renameDocument` and `nameRevision`, and `PATCH` in CORS (done); a rename creates no revision, the last one wins, and the next version saved from the draft takes the new title; the web history panel shows the version names and lets the writer name, rename and clear them (done);
  - the web editor renames through `PATCH`, soon after the writer stops typing and when the title field loses focus (done), and so does the mobile editor (done). The old `PUT /documents/:id` always carries a title and applies it, so it puts an old title back when an app loaded the document before a rename: the web and mobile apps no longer call it, and the limit stays for builds already installed.
- `POST /documents` accepts an empty draft and creates no revision: a document can exist with only a draft.
  - `draftOnly` creates the document at revision 0 with its text in the draft, and every endpoint handles such a document (done); `POST /documents { title, content }` still creates revision 1 for the builds already installed, and their old `PUT` keeps a draft they never saw as revision 1 before answering 409;
  - a creation can be sent again safely (done): the client chooses the document's id; the same creation answers the document as it is now, a different body is refused (422), and an id whose document was deleted is not created again (410);
  - the web's blank page uses it (done); later: the outbox and the mobile app.
- Keep the current `PUT /documents/:id` working as "save draft + create revision" until the new mobile build ships. It keeps the draft columns equal to the saved content, and it never overwrites an autosaved draft that differs from the head: it keeps that draft as a revision first, then answers 409 (done).
- Shared types: structured 409 bodies (done: `draft_conflict` and `stale_revision`, read with `conflictOf`).

Web client — an autosave state machine, not just a debounce:

- one write in flight at a time; edits typed during a request are kept and sent next (done: the framework-free core in `apps/web/src/autosave`, with debounce, retry with backoff, `flush()` and a conflict state, tested with delayed and failed requests); the core is now the workspace package `@reviewr/autosave`, re-exported by the web app, so that the mobile app can use the same machine (done);
- wire the core into the editor and the Composer through `PUT /documents/:id/draft`, with a saved / saving / retrying status; tell permanent failures (a deleted document) apart from temporary ones:
  - the editor of an existing document (done): it opens on the draft and saves it as the writer types; a document left before its text was saved keeps being saved in the background; a deleted document stops the saves for good and a refused text (too large) waits for a change, both with the text left on screen; a newer draft read from the server while the writer has unsaved text is a conflict, never a silent replacement; "Save version" flushes the draft, then saves it as a version through `POST /documents/:id/revisions`, with an optional name; a draft moved elsewhere becomes a conflict, and a head moved elsewhere is retried on the new head;
  - a draft conflict shows a short banner in the editor, whose one action opens the reconciliation view in place of the text (done);
- the Composer creates the document on the first autosave with an idempotency key (retry-safe), and does not lose keystrokes typed while it is being created:
  - the blank page is the editor on a document that does not exist yet, and its first autosave creates it as a draft-only document under an id chosen by the client (done); the creation is sent again unchanged until it is answered, the text typed meanwhile is saved as a draft afterwards, and the text field is not rebuilt, so the caret, the selection and a composition in progress survive;
  - a creation refused for good keeps the text on screen and can be tried again under a new id (done);
  - a page typed while the server is unreachable, or closed before its creation is answered, is kept on the device and comes back after a reload (done, see the local buffer); later: a title typed on a page with no text is not saved until some text is typed;
- local buffer in IndexedDB, restored after a crash or a failed request; it also keeps the base (server draft and `draftVersion` the edits started from):
  - the storage module `apps/web/src/autosave/localBuffer.ts`: writes land in call order, a delete can be conditional on the confirmed text, it never throws into the editor, and its schema is versioned for the outbox (done);
  - used from the editor (done): every edit of a document that exists is written with its base, deleted once the server confirmed that exact text, and restored on start and before the document is shown; if the server moved meanwhile, the usual conflict runs with the right base; when the buffer cannot keep the text, one notice says so, and nothing in memory is reloaded or discarded;
  - two tabs editing the same document (done): each tab writes its own entries and holds a lock while it lives; after a crash, the most recent copy becomes the local text and every other one stays listed, to copy or discard, until it is saved;
  - a page whose document does not exist yet is kept too (done): its entry carries the creation already sent, written before the creation is first sent, so a restore sends the same creation under the same id and never makes a second document; a restored page shows on the blank page;
  - later: the texts of an unfinished merge, the text of a document deleted elsewhere and the unsaved title of an existing document are still in memory only;
- offline mode: an unreachable server (network error, 502/503/504) shows a "Server unreachable" notification, never a blocking error; edits and versions go to an outbox and are sent on reconnect:
  - the notification, and the edits kept on the device and retried until the server is back (done, see the autosave and the local buffer);
  - "Save version" while the draft cannot be saved says that the version was not saved, and what to do next from the draft's state at that moment (done); nothing is queued yet, so the writer saves the version again once the server is back, and types its name again;
  - later, the queue of versions saved while unreachable, in this order: an idempotency key on `POST /documents/:id/revisions`, so that a version sent again after a lost answer is never created twice; then the queue (each version with the text on screen at the click, created in order on reconnect, held with "copy" and "discard" when the draft moved elsewhere); then the queue kept in the local buffer. A first queue without that key was tried and parked (pull request #33): replaying the queued texts through the draft endpoint has to guess what the server holds after every lost answer;
- reconciliation view when both sides moved: three-way word merge of base, mine and theirs, non-overlapping changes applied, conflicts resolved by the writer (mine, theirs, both, edit), the losing side kept as a named version (see [ARCHITECTURE.md](ARCHITECTURE.md#offline-and-reconciliation)):
  - the merge itself: the pure `@reviewr/merge` package, where overlapping, adjacent and ambiguous changes (repeated text) are conflicts (done);
  - the view, built on the package: the standalone component in `apps/web/src/reconcile/` (done), with each change attributed to its side, conflicts resolved by mine, theirs, both or a hand edit ("keep both" opens the hand edit on the two texts joined as they are, so the writer adds the separator), nothing applied before the writer confirms, and a hand edit never dropped when the other side moves again;
  - the view opened from the editor on a draft conflict, its result saved against the server's `draftVersion` (done); if the server moves again or a request fails, the merge stops with the text on screen intact and the view takes the new text;
  - keep the local text as a named version before every reconciliation, not only for conflicts: a few ambiguous merges can still be silent (listed in `packages/merge/README.md`), in particular when one side changed more than about 1,000 words (done in the web editor: each side that the result would erase is kept as a version named after its side and the date, and a text in no revision is kept before anything overwrites it);
  - an unfinished merge is kept per document, outside the editor (done): it survives leaving the document, shows the merged text with "retry" and "dismiss" after a stop, and applies a result only when every text it was given is the result or is in a revision;
  - the view's model and the session are now the workspace package `@reviewr/reconcile`, re-exported by the web app, so that the mobile app reconciles with the same logic (done); later: its tests on Hermes, as for the two other packages;
  - recovery when a merge cannot be finished or the document is gone (done):
    - the texts an unfinished merge still holds, in no revision and not on screen, are listed in the editor, each with "copy" and an explicit "discard";
    - a document deleted elsewhere: while this tab holds text for it (unsaved text, a merged text, texts of a merge), the page lists each text with "copy" and "save as a new document" instead of "not found", and only an explicit "discard" leaves that state;
    - later: these texts are in memory only until the local buffer keeps them; an unsaved title is not offered;
    - to decide: a text that was saved and whose editor was left is no longer held by the tab, so if the document is then deleted elsewhere the tab shows "not found". The risk behind it is a delete made from a stale view, which destroys text saved since: make the delete carry what it saw (revision and `draftVersion`, 409 otherwise), or keep deleted documents recoverable for a while;
  - later: "keep all mine / all theirs" for texts with many conflicts;
  - the package's tests run on a real Hermes runtime in the CI (done): the same cases as on Node, from source and from bytecode, on the Hermes version of the mobile app's React Native; the tests of `@reviewr/autosave` run there too, asynchronous tests and fake timers included (done); later: a run on a real phone, of the bundle Metro builds (on Linux, Hermes uses ICU where Android and iOS use the platform's libraries, and the tests turn on Hermes' own block scoping where Metro's Babel preset rewrites `let` and `const` first);
- flush before "Save version", navigation, `beforeunload` and tab hide (done for every document with unsaved text, including one already left; closing the page can still cut the last request short: the local buffer then brings the text back at the next start on this device);
- later: a read of a document answered late can still put an older draft back in the web's cache after a newer one was saved (the mobile app has a rule against it, see below). No text is lost: a document reopened at that moment starts from the older text until the next read, and a text typed meanwhile shows a conflict with this tab's own save;
- tests with delayed responses, failed requests, typing during creation, and offline edits reconciled against a moved server draft.

Mobile — the same behaviour as the web, on the same packages; the phone is where offline writing happens most:

- the editor on the draft and revision endpoints (done): it opens on the draft and autosaves it through `@reviewr/autosave`, "Save version" saves the draft as a version, the title goes through `PATCH`, and a deleted document or a refused text stays on screen; the app no longer calls the old `PUT /documents/:id`. The logic is tested with Vitest and the bundle is built by Metro; not run on a phone or an emulator yet;
- a draft conflict (done, minimal): "Keep mine" keeps the other device's text as a named version through `@reviewr/reconcile`, then saves the local text; the other device's text and the texts a stopped "Keep mine" holds are shown under the notice, to copy or discard; later: the merge screen, on the same merge package;
- restore goes into the editor (done), and the text it replaces is first kept as a version named "Before restore" when it is in no version; the web's restore follows the same rule (done), and restores nothing when that version cannot be made; later: a title renamed since the last version, with the text unchanged, is in no version and a restore still replaces it (see the title changed alone, above);
- a read answered late never puts an older draft, revision or title back as if it were saved (done);
- later: naming a version and the version names in the history; creating a document as a draft-only document;
- the same look as the web:
  - the buttons (done): History, Delete and Save version are icon buttons in the editor's header, with the web's drawings and order, and "Delete" is no longer under the text; "New" and "Restore into editor" are filled buttons with a label, as on the web. Seen in Expo's web rendering only: not checked on a phone yet;
  - later: the writing stats, shown or hidden from the toolbar as on the web (the phone always shows the number of words, and nothing else);
- local buffer and offline outbox (SQLite):
  - the storage module `apps/mobile/src/lib/localBuffer.ts` on `expo-sqlite` (done): each document's local text with its base, writes in call order, a delete conditional on the confirmed text, nothing thrown into the editor, and a versioned schema that leaves a database written by a newer build untouched; tested with real SQL on Node, a writer killed in the middle of a write included; not run on a phone yet;
  - later: used from the editor (written on every edit, deleted once the server confirmed that text, restored on start, one notice when the text cannot be kept); until then a text typed while the server is unreachable is retried from memory only, and is lost if the app is killed. It needs a new build of the app, since `expo-sqlite` is a native module;
  - later: the outbox (versions, creations and renames made offline);
- later: share with the web what each app now has of its own (reading a failed save, the "Save version" loop, the rule against late reads).

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
