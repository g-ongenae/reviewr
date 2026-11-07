# reviewr — architecture

This document describes where the code is heading. The current state of the code is in the [README](../README.md). The product goals are in [VISION.md](VISION.md).

## Overview

```
┌────────────── clients ──────────────┐
│ web (React)   mobile (Expo iOS/And.)│   editor · lenses · review modes · front-end plugins
│        └──── @reviewr/markup ───────┤   parse markup, segment sentences, run light rules
│        └──── @reviewr/rules  ───────┤
└───────────────┬─────────────────────┘
                │ REST (+ WebSocket later for co-writing)
┌───────────────┴─────────────────────┐
│ api (NestJS)                        │   documents · versions · projects · review · analysis
│   analysis service ── rule registry │   only rules accepted by this instance
│   optional sidecars: LanguageTool,  │
│   LLM provider (off by default)     │
└───────────────┬─────────────────────┘
          PostgreSQL / PGlite
```

### Packages

| Package                 | Status | Role                                                                                                                                                           |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`       | exists | API types, limits, HTTP client                                                                                                                                 |
| `packages/markup`       | new    | Parser for the reviewr markup (front matter, scopes, spans) on top of unified/remark. Outputs a tree with scopes, ready for sentence segmentation. Isomorphic. |
| `packages/rules`        | new    | Rule contract, goal evaluation, built-in rules. Isomorphic: a rule declares whether it may run on the client, the server or both.                              |
| `packages/rules-<lang>` | later  | Language data and rules: word lists, syllabification, verb tables (Morphalou for French), …                                                                    |

Isomorphic packages give the same results in the browser, on the phone and on the server. The client gets instant feedback from light rules. The server runs everything, including heavy rules.

## The reviewr markup

The stored text is Markdown with three additions: front matter, scopes and spans. The preview and the exports can strip them.

### Front matter (configuration)

Front matter is optional. An empty document has none, and it can be added at any time.

The top-level `rules` key holds the **global** rules: they apply to every scope, including the default one. When a text has no characters, that's all it needs:

```yaml
---
lang: fr
rules:
  sentence-length: { goal: { stddev: '<=3' } }
  repetition: { goal: max }
---
Nom d'oiseau.
Autre oiseau rare.
```

The `scopes` key declares named scopes, each with its own rules. Exactly one scope can be marked `default`. It then covers every part of the text outside a named block. `default` can only be set in the front matter.

```yaml
---
scopes:
  narrator: { default: true, rules: { passive-voice: { goal: max } } }
  hero: { rules: { alex: { goal: min } } }
  villain: { rules: { alex: { goal: max } } }
---
```

#### Sharing rules between scopes: `extends`

Scopes don't inherit rules silently. A scope says which other scopes it builds on, the way an ESLint config uses `extends`. Nothing is guessed: the front matter shows where every rule comes from.

```yaml
---
rules: # global: the Goodwells are nice people
  alex: { goal: min }
scopes:
  family: # never used in the text, only extended
    rules: { call-by-name: { goal: max } } # they call each other by name in every sentence
  dad:
    extends: family
    rules: { active-voice: { goal: max } } # action-oriented
  mom:
    extends: family
    rules: { love-words: { goal: { exactly: 1 } } } # one caring word per sentence
  oldest-son:
    extends: family
    rules: { sentence-length: { goal: { mean: '<3' } } } # absent-minded
  middle-son:
    extends: family
    global: false # the only normal one: no global rules
  youngest-son:
    extends: family
    rules: { alex: { goal: max } } # nasty, he has issues
  uncle: # not in the small family, but has the Goodwell roots (global)
    rules: { active-voice: { goal: { range: [0.4, 0.6] } } }
---
```

How the rules of a scope are resolved, from the weakest to the strongest layer:

1. The global rules (top-level `rules`), unless the scope sets `global: false`.
2. Each scope listed in `extends`, in order. A scope's `extends` can be a name or a list, and it applies recursively.
3. The scope's own `rules`.

Rules:

- **A stronger layer replaces a rule entirely.** Options aren't merged. `goal: off` turns a rule off.
- **Any scope can be extended**, whether it's used in the text or not (like `family`).
- **Config errors never block writing.** An unknown scope in `extends`, or a cycle, shows up as a diagnostic on the front matter and is otherwise ignored.
- **The editor can show each scope's resolved rules, with where each one comes from.** The review mode uses this as context.
- **Rules are a map keyed by rule id**, both at the top level and inside scopes. In this map form, a scope can't use the same rule twice.
- **A scope can also take `label` and `lang`.** `label` is a display name.

### Block scopes

A block scope starts with `@@@name` on its own line. It ends at the next `@@@name`, at a bare `@@@` (back to the default scope), or at the end of the document. The closing marker is optional. Blocks don't nest: opening a block closes the current one.

```
They were going west.

@@@hero

I'm wondering if…

@@@villain

I'll make them go east…

@@@

They were now going south.
```

Here, the first and last paragraphs are in the default scope (`narrator`, with the front matter above). The rest is in `hero`, then `villain`.

As in CSS, configuration can be written inline on the block line. It's accepted but discouraged: the front matter is the right place for it.

- `@@@hero lang=de`: attributes, the inline equivalent of the scope's front-matter keys.
- `@@@hero (some comment)`: a comment for the writer, ignored by analysis.

A scope name that isn't declared in the front matter is still valid (nothing blocks writing). It simply has no rules until some are added.

### Inline scopes

An inline scope covers exactly one line, up to the next `\n`. There are two forms:

```
@hero: I'm saying.

@hero:
I'm saying you should not do that because, this would be too long.
```

- `@hero: text` scopes the rest of the line.
- `@hero:` alone on a line scopes the line that follows.

### Spans (tags)

Spans scope part of a line. They use Pandoc's bracketed spans:

- `He whispered [Ich weiß]{lang=de} and left.`
- `He called them [a rude word]{@villain}.`

### Escaping

`\@` writes a literal `@` at the start of a line.

### Parsing

The parser is a micromark/remark extension. It turns the text into an mdast tree with `scope` and `span` nodes. Each piece of text then knows its scope, its language and the rules that apply to it. The text is then split into sentences:

- with parse-latin/retext (an nlcst tree) when a language-specific parser exists;
- with `Intl.Segmenter` as a fallback for any language.

Every node keeps its source offsets, so findings can be shown in the plain editor, the rich view and the review mode.

## Rules

```ts
interface Rule<Options, Value> {
  id: string; // 'sentence-length', 'repetition', 'alex'
  version: string; // part of the cache key
  languages: '*' | string[]; // e.g. ['fr', 'en']
  runtime: 'client' | 'server' | 'both';
  unit: 'document' | 'scope' | 'paragraph' | 'sentence' | 'line';
  measure(unit: TextUnit, options: Options): Measurement<Value>;
}

interface Measurement<Value> {
  value: Value; // a count, a length, a distribution…
  findings: Finding[]; // ranges in the source, with an explanation
}

type Goal =
  | 'off' // disable a rule set by a weaker layer
  | 'display' // only measure and show
  | 'min'
  | 'max' // push the value down or up
  | { range: [number, number] }
  | { exactly: number }
  | { [statistic in 'mean' | 'median' | 'stddev']?: Comparison }; // over all units of a scope

type Comparison = `${'<' | '<=' | '=' | '>=' | '>'}${number}`; // '<=3'
```

A goal on a statistic constrains the whole scope rather than each sentence. For example, `{ stddev: '<=3' }` on `sentence-length` makes every sentence nearly the same length (the robot). A high standard deviation gives varied lengths.

- A rule only **measures**. Turning a measurement into a warning or a success is the job of the goal evaluator, which is shared by every rule. The same rule can then push a text in either direction.
- **Deterministic:** the result depends only on the text, the rule version and its options. The server can therefore cache results by `hash(text) + hash(config) + rule versions`. This also protects the server from repeated or duplicate requests. Clients debounce their requests.
- **Built-in v1 rules:** `sentence-length` and `repetition`. They work in any language. Rules that need language data (syllables, vocabulary lists like alex, passive voice) come after v1.
- **Plugins (later):**
  - Front-end plugins can add rules (with `runtime: 'client'`), lenses, review modes and panels.
  - On the server, an instance keeps an allowlist. The hosted instance only runs vetted rules. Self-hosted instances choose for themselves.
  - Declarative rules (word lists, patterns, counts) are always safe and can be written by users.
- **Language-specific rules** (syllables, vocabulary) live in `rules-<lang>` packages. A rule with no data for the current language is skipped and shown as "not available for <lang>". It never fails.

### Lenses

A lens is a view over the same analysis tree. It assigns decorations to source ranges: colour by sentence length, by character, by part of speech, by syllable count, or bionic reading. Lenses only exist in the rich view and the review mode. They never change the stored text.

## Data model

Designed for multiple users, branches and propositions. v1 only uses part of it.

History is **per document**, not per project. A document carries its whole history with it, so it can be moved into a project, or out of one, at any time.

```
users            id, email, …                         (v1: a single user, but every row has an owner)
documents        id, owner_id, project_id NULL, title NULL, draft_content, draft_base_commit_id,
                 head_commit_id, created_at, updated_at
blobs            hash PK, content                      content-addressed, same text stored once
commits          id, document_id, parent_id NULL, merge_parent_id NULL, blob_hash, title,
                 message NULL, author_id, created_at
refs             document_id, name, commit_id          v1: only 'main'; later branches and propositions
projects         id, owner_id, title NULL, created_at
project_entries  project_id, document_id, position, kind ('chapter', 'poem', …)
annotations      id, document_id, commit_id, kind ('approve' | 'flag' | 'note'), body NULL,
                 anchor (start, end, quote, prefix, suffix), sentence_hash, author_id, created_at
```

- **Draft or version.** Autosave writes `draft_content` and creates no version. "Save" creates a commit and moves `refs.main`. This changes the current behaviour, where every save creates a revision. The existing optimistic locking stays: a save sends its base commit.
- **The title is nullable.** The UI shows a default name ("Untitled — 30 Oct") until a real one is given. It can be renamed at any time.
- **Projects are optional.** Every document exists without one. "New chapter" in a project creates a document and then adds it to the project.
- **Commits have a parent and an optional second (merge) parent from day one**, even while history is linear. Branches, merges and propositions only add rows to `refs` and never require migrating history. Blame and prose diffs are computed from blobs: a diff by word or sentence uses the same segmentation as the rules.
- **Anchors survive edits.** Annotations use a text-quote selector: offsets plus the quoted text plus the text around it (prefix and suffix), as in the W3C Web Annotation model. They are re-anchored on newer versions. An approval stays valid only while the sentence still matches its `sentence_hash`. Once the sentence is edited, it needs a new review.
- **Real-time co-writing (later):** a Yjs document holds the live draft for a session. Commits are still snapshots of it, so live editing and Git-like history don't compete.

### Migration from today's schema

`documents` and `revisions` map onto `documents`, `commits` and `blobs`. Each existing revision becomes a commit whose parent is the previous revision. The current `content` becomes both the draft and `head_commit_id`.

## Offline and reconciliation

The clients work without the server. The server stays the source of truth, but losing the connection must never block writing or lose text.

### On the device

- **Local store:** IndexedDB on the web, SQLite (`expo-sqlite`) on mobile. For each open document it keeps the local draft, plus the **base**: the server draft content and `draftVersion` that the local edits started from. The base is what makes a three-way comparison possible later.
- **Outbox:** pending operations, in order: create document (with its idempotency key), save draft, save version, rename. Draft saves are coalesced (only the latest content is sent). Versions saved offline are queued and created in order on reconnect, after the draft is reconciled.
- **Connection state:** the client is _online_, _offline_ (network error, or 502/503/504 from the proxy), or _syncing_. Offline shows a notification ("Server unreachable") and a "saved on this device" status. It never shows a blocking error. Retries back off, and `online`/`focus` events and the first successful request trigger a sync.
- **Reading offline:** the document list and the documents opened recently are cached, so the app opens and the sidebar is usable without the server. Documents never opened on this device are listed but not editable until the connection is back.

### Sync on reconnect

For each document with pending changes, the client sends its draft with the base `draftVersion`, as autosave already does:

1. **The server didn't move** (`draftVersion` matches): the draft is accepted. Nothing to show.
2. **Only the server moved** (no local edits since the base): the client takes the server draft silently.
3. **Both moved:** the server answers 409 with its current draft and version. The client computes a three-way merge of _base_, _mine_ and _theirs_, by word, and opens the **reconciliation view**.

### The reconciliation view

- Shows the merged text with each change attributed to _mine_ or _theirs_. Changes that don't overlap are already applied. Each overlapping change is a **conflict**, resolved with: keep mine, keep theirs, keep both (one after the other), or edit by hand.
- Nothing is applied until the writer confirms. The result is saved as the new draft against the server's `draftVersion`. If the server moved again meanwhile, the view is refreshed with the new _theirs_.
- **Nothing is ever dropped:** before the result is saved, the losing side of every conflict is kept as a named version ("Offline copy — 7 Nov, phone"), so a wrong choice can always be undone from the history.
- The merge is deterministic (same three texts, same result) and lives in a pure, fixture-tested package shared by web and mobile. It never "guesses" a better sentence: it only places the writer's own changes.
- A deleted document with pending local edits is not lost: the local text is offered as a new document.

### Later

- With commits and refs (v3), offline work becomes a branch from the base commit and reconciliation becomes a regular merge with a `merge_parent_id`. The diff becomes prose-aware: by sentence, using the same segmentation as the rules, with a word diff inside changed sentences.
- With real-time co-writing, Yjs merges live edits automatically. Its updates are still snapshotted into commits, so offline edits reconciled by Yjs remain visible in the history.

## Review modes

A review mode is a front-end plugin that receives the analysis tree and the annotations, and decides:

- which unit to show: a sentence, a chunk of a sentence, or a line;
- in which order;
- with how much context.

| Mode    | Order                                                       | Context                                           |
| ------- | ----------------------------------------------------------- | ------------------------------------------------- |
| default | text order                                                  | surrounding lines, scope, rules and their results |
| focus   | text order                                                  | none                                              |
| random  | shuffled, a sentence can come back but not too soon (later) | configurable                                      |

Splitting long sentences into chunks is a segmentation option (maximum length, split at punctuation), so every mode can use it. Every action (approve, flag, edit, note) produces an annotation or a commit through the API.

## Deployment

| Target      | How                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted      | API with PostgreSQL. Web app. Mobile apps (iOS and Android, Expo) pointing at the hosted API.                                              |
| Self-hosted | `docker compose` with the API, PostgreSQL, the web app, and optional sidecars (LanguageTool, an LLM provider).                             |
| Local       | The API running on the user's machine with embedded PGlite, used through the browser. An Electron shell is optional and not needed for v1. |

- **One schema everywhere:** Drizzle on PostgreSQL, with PGlite for the local target and for tests (already the case for tests).
- **Accounts:** authentication arrives before the public opening (v3). In v1 there is a single user, but every row already has an `owner_id`.
- **Interface language:** the UI is in English, and its strings are extracted from day one so translations can be added later.
- **LLM:** a server plugin, disabled by default. The provider is configured per instance (a hosted API or a local model). It is only exposed through "ask" panels and never writes into the document.

## Exports and data API

- `GET /documents/:id/export?format=txt|md|html|pdf|tex&markup=keep|strip`
- PDF goes through the browser's print output or a Gotenberg sidecar.
- Every resource stays readable through the REST API, so external publishing tools can take over.
