import type { Document } from '@reviewr/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useReducer } from 'react';
import { api, inlineError, isNotFound, queryKeys } from '../api';
import { entryOf } from '../autosave/useAutosave';
import { Editor } from './Editor';
import { DeletedDocument } from './TextRecovery';

interface Props {
  id: string;
  onDeleted: () => void;
  onGoBack: () => void;
  /** Opens another document: one created from a text of this one, after it was deleted. */
  onOpen: (document: Document) => void;
  /** Shown at the start of the toolbar, e.g. the button that unfolds the sidebar. */
  toolbarStart?: ReactNode;
}

/** Loads a document, then hands it to the editor. */
export const DocumentView = ({ id, onDeleted, onGoBack, onOpen, toolbarStart }: Props) => {
  const queryClient = useQueryClient();
  /** Renders again once the writer discarded the texts of a deleted document. */
  const [, discarded] = useReducer((count: number) => count + 1, 0);
  const document = useQuery({
    queryKey: queryKeys.document(id),
    queryFn: () => api.getDocument(id),
    enabled: id.length > 0,
    retry: (failureCount, error) => !isNotFound(error) && failureCount < 3,
  });

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
        title={document.data?.title}
        notFound={notFound}
        onOpen={onOpen}
        onDiscarded={discarded}
        toolbarStart={toolbarStart}
      />
    );
  }

  if (document.isPending) {
    return (
      <div className="padded">
        {toolbarStart}
        <p className="muted">Loading…</p>
      </div>
    );
  }
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

  return <Editor document={document.data} onDeleted={onDeleted} toolbarStart={toolbarStart} />;
};
