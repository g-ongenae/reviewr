import { displayTitle } from '@reviewr/shared';
import { useQuery } from '@tanstack/react-query';
import { api, inlineError, queryKeys } from '../api';
import { formatDate } from '../format';

interface Props {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

export const DocumentList = ({ selectedId, onSelect }: Props) => {
  const documents = useQuery({ queryKey: queryKeys.documents, queryFn: () => api.listDocuments() });

  if (documents.isPending) {
    return <p className="muted">Loading…</p>;
  }
  if (documents.isError) {
    // When the server is unreachable the notification says so: leave the sidebar empty.
    const message = inlineError(documents.error);
    return message === undefined ? null : <p className="error">Could not load documents: {message}</p>;
  }
  if (documents.data.length === 0) {
    return <p className="muted">No documents yet.</p>;
  }

  return (
    <nav>
      <ul className="document-list">
        {documents.data.map((document) => (
          <li key={document.id}>
            <button
              className={document.id === selectedId ? 'document-item selected' : 'document-item'}
              onClick={() => onSelect(document.id)}
            >
              <span className="document-title">{displayTitle(document)}</span>
              <span className="muted small">{formatDate(document.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};
