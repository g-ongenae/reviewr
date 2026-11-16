import type { Document } from '@reviewr/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useEffectEvent, useReducer, useState } from 'react';
import { api, inlineError, isNotFound, queryKeys } from '../api';
import {
  blankDocument,
  entryOf,
  isCreated,
  usePageDeleted,
  useRestored,
  useWaitingTexts,
} from '../autosave/useAutosave';
import { Editor } from './Editor';
import { DeletedDocument, HeldText, keptCopyLabel } from './TextRecovery';

interface Props {
  id: string;
  /** The blank page: a document that may not exist on the server yet, created by its first save. */
  blank?: boolean;
  /** The blank page's document was just created. */
  onCreated?: () => void;
  /** Shows another page not created yet, `id`, on the blank page. */
  onOpenPage?: (id: string) => void;
  onDeleted: () => void;
  onGoBack: () => void;
  /** Opens another document: one created from a text of this one, after it was deleted. */
  onOpen: (document: Document) => void;
  /** Shown at the start of the toolbar, e.g. the button that unfolds the sidebar. */
  toolbarStart?: ReactNode;
}

/** Loads a document, then hands it to the editor. */
export const DocumentView = ({
  id,
  blank = false,
  onCreated,
  onOpenPage,
  onDeleted,
  onGoBack,
  onOpen,
  toolbarStart,
}: Props) => {
  const queryClient = useQueryClient();
  /** Renders again once the writer discarded the texts of a deleted document. */
  const [, discarded] = useReducer((count: number) => count + 1, 0);
  /** The blank page's document until the server has it: nothing is read from the server for it before. */
  const [blankPage] = useState(() => (blank ? blankDocument(id) : undefined));
  const document = useQuery({
    queryKey: queryKeys.document(id),
    queryFn: () => api.getDocument(id),
    enabled: id.length > 0 && (blankPage === undefined || isCreated(queryClient, id)),
    retry: (failureCount, error) => !isNotFound(error) && failureCount < 3,
  });
  // Its creation puts the document in the cache: reading `data` here renders the page again then.
  const uncreated = blankPage !== undefined && document.data === undefined && !isCreated(queryClient, id);
  // A page whose document was deleted elsewhere before this tab created it: its texts go to the recovery below.
  const pageDeleted = usePageDeleted(id);
  const created = useEffectEvent(() => onCreated?.());
  useEffect(() => {
    if (blankPage !== undefined && !uncreated) created();
  }, [blankPage, uncreated]);
  // What this device kept of the document's text comes first: the server's text is not shown before it is restored.
  const restored = useRestored(id, blankPage !== undefined);
  const waiting = useWaitingTexts(id);

  if (uncreated && !pageDeleted) {
    return (
      <Editor document={blankPage} isNew onOpenPage={onOpenPage} onDeleted={onDeleted} toolbarStart={toolbarStart} />
    );
  }

  const loading = (
    <div className="padded">
      {toolbarStart}
      <p className="muted">Loading…</p>
    </div>
  );
  if (restored === 'pending') return loading;
  if (restored === 'deferred') {
    // Texts this device kept for the document wait for the server, to be decided on its draft.
    return (
      <div className="padded">
        {toolbarStart}
        <p className="muted">This document will open as soon as the server is back.</p>
        {waiting.length > 0 && (
          <div className="held-texts">
            <p>
              This device kept {waiting.length === 1 ? 'a text' : 'texts'} of yours for this document that the server
              does not have yet. {waiting.length === 1 ? 'It is' : 'They are'} saved once the server is back; until
              then, copy what you need.
            </p>
            {waiting.map((text) => (
              <HeldText key={text} label={keptCopyLabel} text={text} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // A document known to be gone stays so while a later read is pending or fails for another reason (the server
  // unreachable): only a read that finds the document says otherwise. Until then, the texts this tab holds for it
  // stay reachable.
  const entry = id ? entryOf(queryClient, id) : undefined;
  if (!id || (document.isError && isNotFound(document.error)) || entry?.deleted === true) {
    const notFound = (
      <div className="not-found-page">
        {toolbarStart && <div className="not-found-toolbar">{toolbarStart}</div>}
        <section className="not-found" aria-labelledby="not-found-title">
          <h1 id="not-found-title">404</h1>
          <p>Oh, no tale told here.</p>
          <button className="not-found-back" onClick={onGoBack}>
            <span aria-hidden="true">←</span> Go back.
          </button>
        </section>
      </div>
    );
    // A document deleted elsewhere while this tab holds text for it: the text stays reachable.
    return entry === undefined ? (
      notFound
    ) : (
      <DeletedDocument
        id={id}
        autosave={entry.autosave}
        edited={entry.edited}
        title={document.data?.title ?? entry.title}
        notFound={notFound}
        onOpen={onOpen}
        onDiscarded={discarded}
        toolbarStart={toolbarStart}
      />
    );
  }

  if (document.isPending) return loading;
  if (document.isError) {
    const message = inlineError(document.error);
    return (
      <div className="padded">
        {toolbarStart}
        {message === undefined ? (
          <p className="muted">This document will open as soon as the server is back.</p>
        ) : (
          <p className="error">Could not load this document: {message}</p>
        )}
      </div>
    );
  }

  // The same element as the blank page's above: once created, the page stays the same editor.
  return <Editor document={document.data} onDeleted={onDeleted} toolbarStart={toolbarStart} />;
};
