import type { Document } from '@reviewr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { api, inlineError, queryKeys } from '../api';
import type { Autosave, AutosaveState } from '../autosave/autosave';
import { discardAutosave, entryOf, useKeptCopies } from '../autosave/useAutosave';
import type { QueuedVersion, VersionQueueState } from '../autosave/versionQueue';
import { existingSession, type SessionState, type Side } from '../reconcile/session';

/** How a text a merge holds is labelled, after the side it came from. */
export const earlierTextLabel = (side: Side): string =>
  side === 'mine' ? 'An earlier text of yours' : 'An earlier text from the other device';

/** How a text another tab left on this device, not saved, is labelled besides the local text. */
export const keptCopyLabel = 'Another copy kept on this device';

interface HeldTextProps {
  label: string;
  text: string;
  /** A line under the label, saying what happened to the text. */
  note?: ReactNode;
  /** Actions shown after "Copy". */
  children?: ReactNode;
}

/** A text the writer could lose, read-only, with its label and a way to copy it. */
export const HeldText = ({ label, text, note, children }: HeldTextProps) => {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // Without the clipboard (an insecure origin, a refusal), the text is selected for the writer to copy.
    const select = () => field.current?.select();
    if (navigator.clipboard === undefined) return select();
    navigator.clipboard.writeText(text).then(() => setCopied(true), select);
  };
  return (
    <section className="held-text" aria-label={label}>
      <h3>{label}</h3>
      {note !== undefined && <p className="held-text-note">{note}</p>}
      <textarea ref={field} readOnly value={text} aria-label={label} rows={4} />
      <div className="held-text-actions">
        <button type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {children}
      </div>
    </section>
  );
};

const noSession: SessionState = { running: false, texts: [] };
const noVersions: VersionQueueState = { pending: [], held: [] };

/** How a version saved while the server was unreachable, and not created, is labelled. */
export const versionNotSavedLabel = 'A version not saved';

/**
 * Every text this tab holds for a document its server no longer has: the local text when the writer edited it or it is
 * not saved, the merged text of a stopped merge, the other device's text of a conflict, every text a merge was given,
 * the copies closed tabs left on this device, and the versions saved while the server was unreachable. The first label wins for a text held twice; blank texts hold nothing to
 * recover.
 */
export const recoverableTexts = (
  machine: AutosaveState,
  session: SessionState,
  edited: boolean,
  copies: readonly string[] = [],
  versions: readonly QueuedVersion[] = [],
): { label: string; text: string }[] => {
  const texts: { label: string; text: string }[] = [];
  const add = (text: string, label: string) => {
    if (text.trim() !== '' && !texts.some((item) => item.text === text)) texts.push({ label, text });
  };
  // Saved or not: the server's copy went with the document.
  if (edited || machine.status !== 'saved') add(machine.content, 'Your text');
  if (session.result !== undefined) add(session.result, 'Your merged text, not applied');
  if (machine.status === 'conflict') add(machine.server.content, 'The other device’s text');
  for (const { text, side } of session.texts) add(text, earlierTextLabel(side));
  for (const copy of copies) add(copy, keptCopyLabel);
  for (const { text } of versions) add(text, versionNotSavedLabel);
  return texts;
};

interface DeletedDocumentProps {
  id: string;
  /** The machine this tab still has for the document. */
  autosave: Autosave;
  /** Whether the writer edited the text in this tab. */
  edited: boolean;
  /** The title of the deleted document, when it is known: the new documents take it. */
  title: string | null | undefined;
  /** Shown when the tab holds no text for the document. */
  notFound: ReactNode;
  onOpen: (document: Document) => void;
  onDiscarded: () => void;
  toolbarStart?: ReactNode;
}

/**
 * A document deleted elsewhere while this tab held text for it: each text stays readable and copyable, and can be
 * saved as a new document, until the writer discards them all.
 */
export const DeletedDocument = ({
  id,
  autosave,
  edited,
  title,
  notFound,
  onOpen,
  onDiscarded,
  toolbarStart,
}: DeletedDocumentProps) => {
  const queryClient = useQueryClient();
  const machine = useSyncExternalStore(
    useCallback((listener: () => void) => autosave.subscribe(listener), [autosave]),
    useCallback(() => autosave.getSnapshot(), [autosave]),
  );
  const session = existingSession(autosave);
  const sessionState = useSyncExternalStore(
    useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]),
    useCallback(() => session?.getSnapshot() ?? noSession, [session]),
  );

  const create = useMutation({
    mutationFn: (content: string) => api.createDocument({ title: title ?? null, content }),
    onSuccess: async (document) => {
      queryClient.setQueryData(queryKeys.document(document.id), document);
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      onOpen(document);
    },
  });

  const copies = useKeptCopies(id);
  const queue = entryOf(queryClient, id)?.versions;
  const queued = useSyncExternalStore(
    useCallback((listener: () => void) => queue?.subscribe(listener) ?? (() => {}), [queue]),
    useCallback(() => queue?.getSnapshot() ?? noVersions, [queue]),
  );
  const texts = recoverableTexts(machine, sessionState, edited, copies, [...queued.held, ...queued.pending]);
  if (texts.length === 0) return notFound;

  const discard = () => {
    if (!window.confirm('Discard the copies this tab holds? This tab will no longer show them.')) return;
    discardAutosave(queryClient, id);
    onDiscarded();
  };
  const error = inlineError(create.error);

  return (
    <div className="deleted-document">
      {toolbarStart}
      <section className="deleted-document-body" aria-labelledby="deleted-document-title">
        <h1 id="deleted-document-title">This document was deleted elsewhere</h1>
        <p>
          The original document is gone. These are the copies of its text that this tab still holds: save what you want
          to keep as a new document, or copy it.
        </p>
        {error && <div className="banner error">Could not create the document: {error}</div>}
        {texts.map(({ label, text }) => (
          <HeldText key={text} label={label} text={text}>
            <button type="button" disabled={create.isPending} onClick={() => create.mutate(text)}>
              {create.isPending && create.variables === text ? 'Saving…' : 'Save as a new document'}
            </button>
          </HeldText>
        ))}
        <footer className="deleted-document-footer">
          <button type="button" className="danger" disabled={create.isPending} onClick={discard}>
            Discard these copies
          </button>
        </footer>
      </section>
    </div>
  );
};
