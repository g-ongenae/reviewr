import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, queryKeys } from './api';
import { DocumentList } from './components/DocumentList';
import { DocumentView } from './components/DocumentView';
import { confirmDiscardChanges } from './unsavedChanges';
import { useSelectedDocumentId } from './useHashRoute';

export const App = () => {
  const queryClient = useQueryClient();
  const [selectedId, select] = useSelectedDocumentId();
  const navigate = (id: string | undefined) => {
    if (id !== selectedId && confirmDiscardChanges()) {
      select(id);
    }
  };

  const create = useMutation({
    mutationFn: () => api.createDocument({ title: '', content: '' }),
    onSuccess: async (document) => {
      queryClient.setQueryData(queryKeys.document(document.id), document);
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      select(document.id);
    },
  });

  return (
    <div className="layout">
      <aside className="sidebar">
        <header className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>Reviewr</span>
        </header>
        <button
          className="primary"
          onClick={() => confirmDiscardChanges() && create.mutate()}
          disabled={create.isPending}
        >
          + New document
        </button>
        {create.isError && <p className="error">{errorMessage(create.error)}</p>}
        <DocumentList selectedId={selectedId} onSelect={navigate} />
      </aside>
      <main className="content">
        {selectedId === undefined ? (
          <div className="empty">
            <h1>Write something</h1>
            <p>Pick a document on the left, or create a new one.</p>
          </div>
        ) : (
          <DocumentView key={selectedId} id={selectedId} onDeleted={() => select(undefined)} />
        )}
      </main>
    </div>
  );
};
