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
