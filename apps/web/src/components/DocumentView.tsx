import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, errorMessage, queryKeys } from '../api';
import { Editor } from './Editor';

interface Props {
  sessionWords: number;
  recordWords: (before: string, after: string) => void;
  id: string;
  onDeleted: () => void;
  /** Shown at the start of the toolbar, e.g. the button that unfolds the sidebar. */
  toolbarStart?: ReactNode;
}

/** Loads a document, then hands it to the editor. */
export const DocumentView = ({ id, onDeleted, toolbarStart, sessionWords, recordWords }: Props) => {
  const document = useQuery({ queryKey: queryKeys.document(id), queryFn: () => api.getDocument(id) });

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

  return (
    <Editor
      sessionWords={sessionWords}
      recordWords={recordWords}
      document={document.data}
      onDeleted={onDeleted}
      toolbarStart={toolbarStart}
    />
  );
};
