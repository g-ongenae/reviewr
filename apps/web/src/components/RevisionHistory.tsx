import type { Document, Revision } from '@reviewr/shared';
import { displayTitle } from '@reviewr/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, inlineError, queryKeys } from '../api';
import { formatDate } from '../format';

interface Props {
  document: Document;
  onRestore: (revision: Revision) => void;
  /** Restoring is not possible now (a merge is being saved). */
  restoreDisabled?: boolean;
}

/** Lists past revisions; selecting one previews it and offers to restore it into the editor. */
export const RevisionHistory = ({ document, onRestore, restoreDisabled = false }: Props) => {
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const revisions = useQuery({
    queryKey: queryKeys.revisions(document.id),
    queryFn: () => api.listRevisions(document.id),
  });
  const preview = useQuery({
    queryKey: queryKeys.revision(document.id, selected ?? 0),
    queryFn: () => api.getRevision(document.id, selected ?? 0),
    enabled: selected !== undefined,
    staleTime: Infinity, // Revisions are immutable.
  });

  const revisionsError = inlineError(revisions.error);
  const previewError = inlineError(preview.error);

  return (
    <aside className="history">
      <h2>History</h2>
      {revisions.isPending && <p className="muted">Loading…</p>}
      {revisionsError && <p className="error">{revisionsError}</p>}
      <ul className="revision-list">
        {revisions.data?.map((revision) => (
          <li key={revision.revision}>
            <button
              className={revision.revision === selected ? 'revision-item selected' : 'revision-item'}
              onClick={() => setSelected(revision.revision === selected ? undefined : revision.revision)}
            >
              <span>
                Revision {revision.revision}
                {revision.revision === document.revision && <span className="badge">current</span>}
              </span>
              <span className="muted small">{formatDate(revision.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>

      {selected !== undefined && (
        <div className="preview">
          {preview.isPending && <p className="muted">Loading…</p>}
          {previewError && <p className="error">{previewError}</p>}
          {preview.data && (
            <>
              <h3>{displayTitle({ title: preview.data.title, createdAt: document.createdAt })}</h3>
              <pre className="preview-content">{preview.data.content}</pre>
              {preview.data.revision !== document.revision && (
                <button
                  className="primary"
                  disabled={restoreDisabled}
                  onClick={() => preview.data && onRestore(preview.data)}
                >
                  Restore into editor
                </button>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
};
