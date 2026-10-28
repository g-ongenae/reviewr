import { useQuery } from '@tanstack/react-query';
import { api, errorMessage, queryKeys } from '../api';
import { Editor } from './Editor';

interface Props {
  id: string;
  onDeleted: () => void;
}

/** Loads a document, then hands it to the editor. */
export const DocumentView = ({ id, onDeleted }: Props) => {
  const document = useQuery({ queryKey: queryKeys.document(id), queryFn: () => api.getDocument(id) });

  if (document.isPending) {
    return <p className="muted padded">Loading…</p>;
  }
  if (document.isError) {
    return <p className="error padded">Could not load this document: {errorMessage(document.error)}</p>;
  }

  return <Editor document={document.data} onDeleted={onDeleted} />;
};
