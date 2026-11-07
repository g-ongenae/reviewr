# reviewr — vision

> An IDE for stories. A ruler, not an intelligence.

reviewr is an editor for people who write fiction and poetry. Developers have editors that show the structure of their code, measure it, lint it and keep its history. reviewr brings the same tools to prose, without ever writing in your place.

## Principles

1. **Nothing blocks writing.** You open reviewr and you get a blank page. No title, no project, no plan, no rules. Everything else (naming, organising, constraining) can come later, while you write or after. Not even a lost connection stops you: reviewr keeps working offline and catches up when the server is back.
2. **A ruler, not an intelligence.** reviewr measures, highlights and checks the text. It never rewrites it. Analysis is deterministic: the same text with the same rules always gives the same result. LLM features are an optional last resort, off by default, and only answer questions ("give me names for a new character"). They never edit the text.
3. **Rules are measurements; the writer sets the goal.** A rule doesn't know what is "good". The writer decides which way to push it:
   - A villain's dialogue can _maximise_ the insensitive words `alex` finds, and a saint's can _minimise_ them.
   - A robot's sentences can aim for _uniform_ length, while the narration aims for _varied_ length (write-music).
   - A poem can require _exactly_ 12 syllables per line (alexandrines).
4. **Rules apply to a scope.** A scope is a document, a chapter, a passage, or a character's voice. The robot's rule doesn't apply to the narrator. Scopes share rules explicitly: a family's habits are declared once, and each member `extends` them. Nothing is inherited invisibly.
5. **Plain text is the source of truth.** What is saved is plain text: Markdown, a small reviewr markup for scopes and characters, and front matter for configuration. Highlighting, the rich view and the preview are only _views_ computed from it.
6. **The tool adapts to the writer.** Write on desktop, in a browser or on a phone, hosted or self-hosted. reviewr is opinionated about only two things: how projects are built (bottom-up, from what is already written) and the markup for tags and rules.
7. **Start from what is written, not from a plan.** Documents exist on their own. A project is something you build later out of documents you already have. Creating an empty project or a chapter first is allowed, but never encouraged.

## Who it is for

- **First user:** the author of reviewr. They write mainly in French, and also in English, Portuguese, German and Polish.
- **Then:** anyone with an account on the hosted version, or on their own instance (self-hosted, or local on their machine). It follows the model of Lago, PostHog and Rocket.chat.

## The writing flow

1. Sign in.
2. Get a blank page.
3. Write. The draft is autosaved after a short delay. An autosave is _not_ a version.
4. Stop writing. Save, which creates a version, and give it a name. The name is easy to change later, and until then the document has a default name.
5. Later, gather existing documents into a project, as chapters, poems of a collection, and so on.

## Features

### Editor

- A plain-text editor by default.
- A rich/highlighting view, off by default and toggled by the user.
- A preview that renders the text without the reviewr markup.
- Character and scope markup: blocks (`@@@hero`), inline lines (`@hero: …`) and spans (see [ARCHITECTURE.md](ARCHITECTURE.md#the-reviewr-markup)).
- Front matter for language and rules, which can be added at any point while writing.

### Rules and lenses

- **Rules** measure a scope and report findings against a goal: sentence length, syllables, vocabulary (alex-like word lists), repetition. Later: readability, passive voice, weasel words, caring words, calling the other person by their name, LanguageTool checks, Oulipo constraints (lipogram, S+7, …), and trunslutur-style transforms.
- **Lenses** are highlighting views: sentence length (write-music), parts of speech, characters, syllables, bionic reading.
- Almost everything on the front end can be extended by plugins. The server only runs rules it has accepted.

### Review modes

- **Default review:** one sentence at a time in the centre of the screen, with actions (approve, flag, edit inline, add a note). Around it: the context (surrounding lines, scope, the rules that apply).
- **Focus (blind) review:** only the sentence, with no context.
- **Later, random review:** sentences in random order. It avoids repeating the same sentence too soon, but allows seeing it again in long sessions, because a sentence reads differently after a different neighbour. Long sentences (Proust) are split into chunks. Everything is configurable: chunking, chunk size, repeats, randomness.

### Offline and reconciliation

- **Write without a connection.** On the train, on a plane, or when the server is down, the editor keeps working on the web and on the phone. The text is kept on the device, and a discreet notification ("Server unreachable") says that changes are waiting to be sent. Nothing is lost and nothing is blocked.
- **Catch up on reconnect.** When the server is back, the waiting changes are sent. If nobody else touched the document in the meantime, this happens silently.
- **Reconcile when both sides changed.** If the document was also edited elsewhere (another tab, the phone, later a co-author), reviewr never picks a winner on its own. It opens a reconciliation view: a diff of the two texts against the version they both started from. Changes that don't overlap are already combined. Each conflict is resolved by the writer: keep mine, keep theirs, keep both, or edit by hand. Whatever is set aside is kept as a version, so it can always be found again.
- **Later:** the diff becomes prose-aware (by sentence, with the same segmentation as the rules), and offline work becomes a branch that is merged like any other.

### History

- **v1:** linear versions, as today.
- **Later:** Git-like history with commits and messages, branches (alternative versions of a scene), merges, prose-aware diffs (by word or sentence) and blame. Exporting or importing a real Git repository would be a nice extra, not a requirement.

### Together (later)

- **Propositions:** someone suggests a change, and the author accepts or rejects it. These are branches from other people, like pull requests on a story. This could suit a Twitch audience (the stream itself happens on Twitch, outside reviewr).
- **Polls:** "which direction next?"
- **Cadavre exquis** and other collaborative writing games.
- **Real-time co-writing** for people who write together.

### Out

- **Exports:** plain text, Markdown, HTML, PDF and LaTeX, with the reviewr markup kept or stripped.
- **A data API:** "get your data and do what you want with it".
- **No publishing platform.** There are enough of them.

## Not reviewr

- A grammar fixer that rewrites sentences for you.
- An AI co-author.
- A publishing or reading platform.
- A tool that asks you to plan before you write.

## Roadmap

| Phase | Content                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1    | Single user. English UI, ready for translation. Plain editor with markup and preview. Autosaved draft and named versions (linear). Works offline, with a reconciliation view (diff, conflicts) on reconnect. 2 language-independent rules with goals (sentence length, repetition). Default and focus review. |
| v2    | Projects built from documents. More rules and lenses. Plugin API. Exports and data API. UI translations. Language-specific rules: syllables, vocabulary, French first.                                                                                                                                        |
| v3    | Accounts open to the public. Git-like branches, merges, diffs and blame. Offline work merged as a branch, with prose-aware diffs. Random review.                                                                                                                                                              |
| v4    | Propositions, polls, cadavre exquis, real-time co-writing. Optional LLM "muse" plugin.                                                                                                                                                                                                                        |

The data model is designed for v3 and v4 from the start, even though v1 only uses part of it.
