import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, errorMessage, isNotFound, queryKeys } from '../api';
import { Editor } from './Editor';

interface Props {
  id: string;
  onDeleted: () => void;
  onGoBack: () => void;
  /** Shown at the start of the toolbar, e.g. the button that unfolds the sidebar. */
  toolbarStart?: ReactNode;
}

/** Loads a document, then hands it to the editor. */
export const DocumentView = ({ id, onDeleted, onGoBack, toolbarStart }: Props) => {
  const document = useQuery({
    queryKey: queryKeys.document(id),
    queryFn: () => api.getDocument(id),
    enabled: id.length > 0,
    retry: (failureCount, error) => !isNotFound(error) && failureCount < 3,
  });

  if (!id || (document.isError && isNotFound(document.error))) {
    return (
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
    return (
      <div className="padded">
        {toolbarStart}
        <p className="error">Could not load this document: {errorMessage(document.error)}</p>
      </div>
    );
  }

  return <Editor document={document.data} onDeleted={onDeleted} toolbarStart={toolbarStart} />;
};
