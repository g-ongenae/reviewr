import type { Document } from '@reviewr/shared';
import { contentMaxLength, describeError, displayTitle, titleMaxLength, titleToSend } from '@reviewr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useEffectEvent, useState } from 'react';
import { api, inlineError, isConflict, isNotFound, queryKeys } from '../api';
import type { AutosaveState } from '../autosave/autosave';
import { draftOf, useAutosave } from '../autosave/useAutosave';
import { setUnsavedChanges } from '../unsavedChanges';
import { useLastRevisionBaseline, useTodayBaseline } from '../useTodayBaseline';
import { RevisionHistory } from './RevisionHistory';
import { useWritingStatsPanel, WritingStatsPanel, WritingStatsToggle } from './WritingStats';

interface Props {
  document: Document;
  onDeleted: () => void;
  toolbarStart?: ReactNode;
}

/** What the toolbar says about the text: whether it is on the server, and whether it differs from the last version. */
const statusText = (state: AutosaveState, revision: number, changedSinceVersion: boolean): string => {
  switch (state.status) {
    case 'unsaved':
      return 'Unsaved changes';
    case 'saving':
      return 'Saving…';
    case 'retrying':
      return 'Not saved · retrying';
    case 'conflict':
      return 'Not saved · changed elsewhere';
    case 'rejected':
      return 'Not saved';
    case 'saved':
      return changedSinceVersion ? `Draft saved · changed since revision ${revision}` : `Saved · revision ${revision}`;
  }
};

export const Editor = ({ document, onDeleted, toolbarStart }: Props) => {
  const queryClient = useQueryClient();
  const { autosave, state, discard } = useAutosave(document);
  /** As typed: empty when the document is untitled. Not part of the draft: it is saved with the next version. */
  const [title, setTitle] = useState(document.title ?? '');
  const { content } = state;
  const [showHistory, setShowHistory] = useState(false);
  const [showStats, toggleStats] = useWritingStatsPanel();
  const todayBaseline = useTodayBaseline(document);
  const previousRevision = useLastRevisionBaseline(document);
  const titleDirty = titleToSend(title) !== titleToSend(document.title ?? '');
  /** Whether "Save version" has something to save. */
  const changedSinceVersion = titleDirty || content !== document.content;
  /** Text that leaving the page could lose, even though the autosave keeps trying in the background. */
  const textAtRisk = state.status === 'retrying' || state.status === 'conflict' || state.status === 'rejected';

  const onSaved = async (saved: Document) => {
    queryClient.setQueryData(queryKeys.document(saved.id), saved);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) }),
    ]);
  };

  /**
   * Saves a version: the draft first, then the old `PUT`, which turns a draft equal to its content into a revision.
   * When the draft cannot be saved, nothing more happens: the status says why.
   */
  const save = useMutation({
    mutationFn: async (): Promise<Document | undefined> => {
      if ((await autosave.flush()) !== 'saved') return undefined;
      return api.updateDocument(document.id, {
        title: titleToSend(title),
        content: autosave.getSnapshot().base.content,
        baseRevision: document.revision,
      });
    },
    onSuccess: async (saved) => {
      if (saved !== undefined) await onSaved(saved);
    },
  });

  /** After a stale revision: save the text as a version on top of the latest one, which stays in the history. */
  const overwrite = useMutation({
    mutationFn: async () => {
      const latest = await api.getDocument(document.id);
      return api.updateDocument(document.id, {
        title: titleToSend(title),
        content: autosave.getSnapshot().base.content,
        baseRevision: latest.revision,
      });
    },
    onSuccess: async (saved) => {
      save.reset();
      await onSaved(saved);
    },
  });

  /** After a stale revision: drop the local text and title, and load the latest version. */
  const reload = async () => {
    const latest = await queryClient.fetchQuery({
      queryKey: queryKeys.document(document.id),
      queryFn: () => api.getDocument(document.id),
      staleTime: 0,
    });
    setTitle(latest.title ?? '');
    autosave.edit(latest.content);
    save.reset();
    await onSaved(latest);
  };

  /**
   * After a draft conflict: keep the other device's draft in the history, as a version, then save the local text on
   * top of it.
   */
  const keepMine = useMutation({
    mutationFn: async () => {
      const latest = await api.getDocument(document.id);
      const theirs = draftOf(latest);
      if (theirs.content !== latest.content) {
        await onSaved(
          await api.updateDocument(document.id, {
            title: latest.title,
            content: theirs.content,
            baseRevision: latest.revision,
          }),
        );
      }
      return theirs;
    },
    onSuccess: (theirs) => autosave.resolve(autosave.getSnapshot().content, theirs.draftVersion),
  });

  /** After a draft conflict: drop the local text and take the other device's draft. */
  const takeTheirs = () => {
    const snapshot = autosave.getSnapshot();
    if (snapshot.status === 'conflict') autosave.resolve(snapshot.server.content, snapshot.server.draftVersion);
  };

  const remove = useMutation({
    mutationFn: () => api.deleteDocument(document.id),
    onSuccess: async () => {
      discard();
      setUnsavedChanges(false);
      queryClient.removeQueries({ queryKey: queryKeys.document(document.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      onDeleted();
    },
  });

  const canSave = changedSinceVersion && !save.isPending && state.status !== 'conflict' && state.status !== 'rejected';
  const saveNow = useEffectEvent(() => {
    if (canSave) save.mutate();
  });

  // Ctrl/Cmd + S saves a version.
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

  // Switching document keeps saving the text in the background: ask only when it is at risk, or for the title.
  useEffect(() => setUnsavedChanges(titleDirty || textAtRisk), [titleDirty, textAtRisk]);
  useEffect(() => () => setUnsavedChanges(false), []);

  // Closing the page may cut the request short: save at once, and warn until the server has the text.
  const onBeforeUnload = useEffectEvent((event: BeforeUnloadEvent) => {
    void autosave.flush();
    if (titleDirty || autosave.getSnapshot().status !== 'saved') event.preventDefault();
  });
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => onBeforeUnload(event);
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, []);

  // An unreachable server is reported by the notification; the text stays here, and the autosave keeps trying.
  const actionError = inlineError(save.error ?? remove.error ?? overwrite.error ?? keepMine.error);
  const status = save.isPending ? 'Saving…' : statusText(state, document.revision, changedSinceVersion);

  return (
    <div className="editor-layout">
      <section className="editor">
        <div className="toolbar">
          {toolbarStart}
          <span
            className={state.status === 'saved' && !save.isPending ? 'status' : 'status dirty'}
            role="status"
            title={state.status === 'retrying' ? describeError(state.error) : undefined}
          >
            {status}
          </span>
          <span className="spacer" />
          <WritingStatsToggle open={showStats} onToggle={toggleStats} />
          <button onClick={() => setShowHistory((value) => !value)}>{showHistory ? 'Hide history' : 'History'}</button>
          <button
            className="danger"
            disabled={remove.isPending}
            onClick={() => window.confirm('Delete this document and its whole history?') && remove.mutate()}
          >
            Delete
          </button>
          <button className="primary" disabled={!canSave} onClick={() => save.mutate()} title="Ctrl+S">
            Save version
          </button>
        </div>

        {showStats && (
          <div className="writing-stats-anchor">
            <WritingStatsPanel
              content={content}
              baseline={todayBaseline}
              lastRevision={{ content: document.content, previous: previousRevision }}
            />
          </div>
        )}

        {state.status === 'rejected' ? (
          <div className="banner error" role="alert">
            <span>
              {isNotFound(state.error)
                ? 'This document was deleted elsewhere: your text is no longer saved. Copy it before leaving.'
                : `Your text can no longer be saved (${describeError(state.error)}). Copy it before leaving.`}
            </span>
          </div>
        ) : state.status === 'conflict' ? (
          <div className="banner" role="alert">
            <span>This text was also changed on another device.</span>
            <button onClick={takeTheirs}>Discard mine, use the other text</button>
            <button className="primary" disabled={keepMine.isPending} onClick={() => keepMine.mutate()}>
              Keep mine, save the other as a version
            </button>
          </div>
        ) : isConflict(save.error) ? (
          <div className="banner">
            <span>A newer version was saved elsewhere since you opened this document.</span>
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
          placeholder={displayTitle({ title: undefined, createdAt: document.createdAt })}
          value={title}
          maxLength={titleMaxLength}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          className="content-input"
          placeholder="Start writing…"
          value={content}
          maxLength={contentMaxLength}
          onChange={(event) => autosave.edit(event.target.value)}
          autoFocus
        />
      </section>

      {showHistory && (
        <RevisionHistory
          document={document}
          onRestore={(revision) => {
            setTitle(revision.title ?? '');
            autosave.edit(revision.content);
          }}
        />
      )}
    </div>
  );
};
