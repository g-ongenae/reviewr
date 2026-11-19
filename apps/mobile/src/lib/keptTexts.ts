import type { Document } from '@reviewr/shared';
import { ApiError } from '@reviewr/shared';
import { draftOf, type Drafts } from './drafts';
import type { BufferEntry } from './localBuffer';
import type { LocalCopy } from './localCopy';

/**
 * The texts the phone kept in its local buffer when the app was last stopped (killed, crashed, or closed before the
 * server confirmed them), brought back as the local text of their documents.
 *
 * The buffer is read once, as the app starts. Each kept text is then decided on the document's draft read from the
 * server just then: dropped if the server holds it, else reopened as the local text on the base it was written from
 * (see `Drafts.recover`), and saved in the background. Until a kept text is decided, its document is not shown
 * (`blocking`): an editor opened on the server's draft would show it as the writer's text, and its first write would
 * replace the kept one.
 *
 * A text whose document cannot be read waits, and is tried again when the server is back and whenever the document is
 * opened. The buffer itself is the only other copy of it, so it stays there meanwhile.
 *
 * If the buffer cannot be read as the app starts, nothing is restored and nothing is written to it until the next
 * start (see `scan`).
 *
 * Left for later: rows without a base (pages not created on the server yet: the phone writes none), rows that cannot
 * be read, and the kept text of a document deleted elsewhere (it stays in the buffer, not shown).
 */
export interface KeptTexts {
  /** Restores every kept text, or only that of `id`, one restore at a time. Never rejects. */
  restore(id?: string): Promise<void>;
  /** Why the document `id` cannot be shown yet (a kept text of it waits), or `undefined`. */
  blocking(id: string): unknown;
}

export interface KeptTextsOptions {
  copy: LocalCopy;
  drafts: Drafts;
  /** Reads a document from the server, as it is now. */
  getDocument: (id: string) => Promise<Document>;
}

const goneStatuses = new Set([404, 410]);

export const createKeptTexts = ({ copy, drafts, getDocument }: KeptTextsOptions): KeptTexts => {
  /** Whether the buffer was read, or found unreadable: until then, every document waits. */
  let scanned = false;
  /** The kept texts not decided yet, by document, and why the last try could not decide. */
  const waiting = new Map<string, { entry: BufferEntry; error?: unknown }>();
  let chain: Promise<void> = Promise.resolve();

  const scan = async () => {
    const result = await copy.list();
    scanned = true;
    if ('failure' in result) {
      // What the buffer holds is unknown: documents open as without it, and nothing is written to it for the rest of
      // this run, so that no write replaces a text it kept. That text comes back at the next start (one more conflict
      // at worst, if the writer changed the document meanwhile). The writer was told that no copy is kept.
      copy.disable();
      return;
    }
    for (const entry of result.entries) {
      if (entry.base === null || drafts.get(entry.key) !== undefined) continue;
      waiting.set(entry.key, { entry });
    }
  };

  const decide = async (id: string, entry: BufferEntry) => {
    const { base } = entry;
    if (base === null) return;
    let document: Document;
    try {
      document = await getDocument(id);
    } catch (error) {
      // Deleted elsewhere: the text stays in the buffer (left for later), and the document is not blocked.
      if (error instanceof ApiError && goneStatuses.has(error.status)) waiting.delete(id);
      else waiting.set(id, { entry, error });
      return;
    }
    waiting.delete(id);
    if (entry.content === draftOf(document).content) copy.drop(id, entry.content);
    else drafts.recover(document, { content: entry.content, base });
  };

  const run = async (id?: string) => {
    if (!scanned) await scan();
    for (const [key, { entry }] of [...waiting]) {
      if (id === undefined || key === id) await decide(key, entry);
    }
  };

  return {
    restore(id) {
      const next = chain.then(() => run(id));
      chain = next.catch(() => undefined);
      return chain;
    },

    blocking(id) {
      // Only before the first restore ran, which `fetchDocument` always awaits.
      if (!scanned) return new Error('The text kept on this phone is not read yet');
      const kept = waiting.get(id);
      return kept === undefined
        ? undefined
        : (kept.error ?? new Error('The text kept on this phone is not restored yet'));
    },
  };
};
