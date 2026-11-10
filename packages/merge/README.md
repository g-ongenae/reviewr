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
- Over repeated text, a change counts everywhere it could have been made. Each side is aligned with the base twice,
  preferring the earliest, then the latest of equal matches. A base token both alignments keep, as the same token of
  that side, is an anchor; a change covers, for the conflict test, all the base text between the anchors around it.
  Deleting one of two identical sentences `Elle attend.` while the other side changes the first into `Elle part.` is a
  conflict, because nothing says which sentence was deleted, even when the deletion is part of a larger change. The
  same deletion still merges cleanly with a change elsewhere. A conflict region is still where the earliest alignment
  placed the changes, so "keep both" never repeats the shared text.
- A conflict is resolved with `'mine'`, `'theirs'`, `'both'` (mine then theirs, exactly as written) or `{ edit }`.
