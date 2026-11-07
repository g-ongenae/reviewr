import type { Document } from '@reviewr/shared';
import { contentMaxLength, titleMaxLength } from '@reviewr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useEffectEvent, useState } from 'react';
import { api, inlineError, isConflict, queryKeys } from '../api';
import { countWords } from '../format';
import { setUnsavedChanges } from '../unsavedChanges';
import { RevisionHistory } from './RevisionHistory';

interface Props {
  document: Document;
  onDeleted: () => void;
  toolbarStart?: ReactNode;
}

interface Draft {
  title: string;
  content: string;
}

export const Editor = ({ document, onDeleted, toolbarStart }: Props) => {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ title: document.title, content: document.content });
  const [showHistory, setShowHistory] = useState(false);
  const dirty = draft.title !== document.title || draft.content !== document.content;

  const onSaved = async (saved: Document) => {
    queryClient.setQueryData(queryKeys.document(saved.id), saved);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) }),
    ]);
  };

  const save = useMutation({
    mutationFn: (baseRevision: number) => api.updateDocument(document.id, { ...draft, baseRevision }),
    onSuccess: onSaved,
  });

  /** After a conflict: keep the local draft and save it on top of the latest version. */
  const overwrite = useMutation({
    mutationFn: async () => {
      const latest = await api.getDocument(document.id);
      return api.updateDocument(document.id, { ...draft, baseRevision: latest.revision });
    },
    onSuccess: async (saved) => {
      save.reset();
      await onSaved(saved);
    },
  });

  /** After a conflict: drop the local draft and load the latest version. */
  const reload = async () => {
    const latest = await queryClient.fetchQuery({
      queryKey: queryKeys.document(document.id),
      queryFn: () => api.getDocument(document.id),
      staleTime: 0,
    });
    setDraft({ title: latest.title, content: latest.content });
    save.reset();
    await onSaved(latest);
  };

  const remove = useMutation({
    mutationFn: () => api.deleteDocument(document.id),
    onSuccess: async () => {
      setUnsavedChanges(false);
      queryClient.removeQueries({ queryKey: queryKeys.document(document.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      onDeleted();
    },
  });

  const saveNow = useEffectEvent(() => {
    if (dirty && !save.isPending) {
      save.mutate(document.revision);
    }
  });

  // Ctrl/Cmd + S saves.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveNow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Warn before leaving the page or switching document with unsaved changes.
  useEffect(() => {
    setUnsavedChanges(dirty);
    if (!dirty) {
      return undefined;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  useEffect(() => () => setUnsavedChanges(false), []);

  // An unreachable server is reported by the notification; the draft stays here, ready to save again.
  const actionError = inlineError(save.error ?? remove.error ?? overwrite.error);
  const status = save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : `Saved · revision ${document.revision}`;

  return (
    <div className="editor-layout">
      <section className="editor">
        <div className="toolbar">
          {toolbarStart}
          <span className={dirty ? 'status dirty' : 'status'}>{status}</span>
          <span className="muted small">{countWords(draft.content)} words</span>
          <span className="spacer" />
          <button onClick={() => setShowHistory((value) => !value)}>{showHistory ? 'Hide history' : 'History'}</button>
          <button
            className="danger"
            disabled={remove.isPending}
            onClick={() => window.confirm('Delete this document and its whole history?') && remove.mutate()}
          >
            Delete
          </button>
          <button
            className="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate(document.revision)}
            title="Ctrl+S"
          >
            Save
          </button>
        </div>

        {isConflict(save.error) ? (
          <div className="banner">
            <span>This document was changed elsewhere since you opened it.</span>
            <button onClick={() => void reload()}>Discard my changes</button>
            <button className="primary" disabled={overwrite.isPending} onClick={() => overwrite.mutate()}>
              Keep my version
            </button>
          </div>
        ) : (
          actionError && <div className="banner error">{actionError}</div>
        )}

        <input
          className="title-input"
          placeholder="Untitled"
          value={draft.title}
          maxLength={titleMaxLength}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <textarea
          className="content-input"
          placeholder="Start writing…"
          value={draft.content}
          maxLength={contentMaxLength}
          onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          autoFocus
        />
      </section>

      {showHistory && (
        <RevisionHistory
          document={document}
          onRestore={(revision) => setDraft({ title: revision.title, content: revision.content })}
        />
      )}
    </div>
  );
};
