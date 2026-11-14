import type { Document, Revision, RevisionSummary } from '@reviewr/shared';
import { displayTitle, revisionNameMaxLength } from '@reviewr/shared';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { api, inlineError, queryKeys } from '../api';
import { formatDate } from '../format';
import './RevisionHistory.css';

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
    staleTime: Infinity, // The text of a revision never changes; only its name does, set from here.
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
          <RevisionRow
            key={revision.revision}
            revision={revision}
            current={revision.revision === document.revision}
            selected={revision.revision === selected}
            onSelect={() => setSelected(revision.revision === selected ? undefined : revision.revision)}
          />
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

/** Key of the request naming one revision: one at a time per revision, even across remounts of the panel. */
const nameRevisionKey = (revision: RevisionSummary) =>
  ['nameRevision', revision.documentId, revision.revision] as const;

interface RowProps {
  revision: RevisionSummary;
  current: boolean;
  selected: boolean;
  onSelect: () => void;
}

/** One revision: its name first when it has one, and a pencil to name, rename or clear it in place. */
const RevisionRow = ({ revision, current, selected, onSelect }: RowProps) => {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const focusEditButton = useRef(false);
  // A save left running by a panel closed meanwhile: no second edit until it is answered.
  const saving = useIsMutating({ mutationKey: nameRevisionKey(revision) }) > 0;

  useEffect(() => {
    if (!editing && focusEditButton.current) {
      focusEditButton.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  const close = () => {
    focusEditButton.current = true;
    setEditing(false);
  };

  const label = `Revision ${revision.revision}`;
  const date = formatDate(revision.createdAt);

  return (
    <li className={selected ? 'revision-row selected' : 'revision-row'}>
      {editing ? (
        <RevisionNameForm revision={revision} onDone={close} />
      ) : (
        <>
          <button className={selected ? 'revision-item selected' : 'revision-item'} onClick={onSelect}>
            {revision.name === null ? (
              <>
                <span>
                  {label}
                  {current && <span className="badge">current</span>}
                </span>
                <span className="muted small">{date}</span>
              </>
            ) : (
              <>
                <span className="revision-name-line">
                  <span className="revision-name" title={revision.name}>
                    {revision.name}
                  </span>
                  {current && <span className="badge">current</span>}
                </span>
                <span className="muted small">
                  {label} · {date}
                </span>
              </>
            )}
          </button>
          <button
            ref={editButton}
            className="icon-button revision-name-edit"
            aria-label={
              revision.name === null ? `Name revision ${revision.revision}` : `Rename revision ${revision.revision}`
            }
            title={revision.name === null ? 'Name this version' : 'Rename this version'}
            disabled={saving}
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </button>
        </>
      )}
    </li>
  );
};

interface FormProps {
  revision: RevisionSummary;
  onDone: () => void;
}

/** Inline field for a revision's name: Enter saves, Escape cancels, an empty name clears it. */
const RevisionNameForm = ({ revision, onDone }: FormProps) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(revision.name ?? '');
  const errorId = useId();
  const save = useMutation({
    mutationKey: nameRevisionKey(revision),
    mutationFn: (value: string) =>
      api.nameRevision(revision.documentId, revision.revision, value.trim() === '' ? null : value),
    onSuccess: async (saved) => {
      const listKey = queryKeys.revisions(saved.documentId);
      const fullKey = queryKeys.revision(saved.documentId, saved.revision);
      // A read sent before this answer may still hold the old name: drop it, so it cannot overwrite the new one.
      await queryClient.cancelQueries({ queryKey: listKey, exact: true });
      await queryClient.cancelQueries({ queryKey: fullKey, exact: true });
      // Show the server's answer, keeping every other row; the text of the revision is not touched.
      queryClient.setQueryData<RevisionSummary[]>(queryKeys.revisions(saved.documentId), (list) =>
        list?.map((item) => (item.revision === saved.revision ? { ...item, ...saved } : item)),
      );
      queryClient.setQueryData<Revision>(queryKeys.revision(saved.documentId, saved.revision), (full) =>
        full === undefined ? undefined : { ...full, ...saved },
      );
      // Read both again, so what the cancelled reads would have brought (a version saved meanwhile) still shows.
      void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: fullKey, exact: true });
      onDone();
    },
  });
  const error = inlineError(save.error);
  const pending = save.isPending;
  const submit = () => {
    if (!pending) save.mutate(name);
  };

  return (
    <form
      className="revision-name-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      aria-busy={pending}
    >
      <input
        className="revision-name-input"
        aria-label={`Name of revision ${revision.revision}`}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        placeholder="Name this version"
        value={name}
        // While the name is being saved, nothing typed could be kept: the field waits for the answer.
        readOnly={pending}
        maxLength={revisionNameMaxLength}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!pending) onDone();
          }
        }}
      />
      <div className="revision-name-actions">
        <span className="muted small">Revision {revision.revision}</span>
        <button type="button" className="revision-name-cancel" disabled={pending} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && (
        <p id={errorId} className="error small revision-name-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
};

const PencilIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21.2 6.8a2.8 2.8 0 0 0-4-4L4 16v4h4z" />
    <path d="m15 5 4 4" />
  </svg>
);
