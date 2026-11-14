import type { Document } from '@reviewr/shared';
import { contentMaxLength, describeError, displayTitle, titleMaxLength, titleToSend } from '@reviewr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import { api, inlineError, isConflict, isNotFound, queryKeys } from '../api';
import type { AutosaveState } from '../autosave/autosave';
import { draftOf, useAutosave } from '../autosave/useAutosave';
import { ReconciliationView } from '../reconcile/ReconciliationView';
import { hiddenTexts, sessionFor, type Stop } from '../reconcile/session';
import { setUnsavedChanges } from '../unsavedChanges';
import { useLastRevisionBaseline, useTodayBaseline } from '../useTodayBaseline';
import { RevisionHistory } from './RevisionHistory';
import { earlierTextLabel, HeldText } from './TextRecovery';
import { HistoryIcon, SaveIcon, TrashIcon } from './ToolbarIcons';
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

/** What happened to a merged text that was not applied. */
const stopText = (stop: Stop): string => {
  switch (stop.reason) {
    case 'moved':
      return 'The other device changed the text again, so your merged text was not applied.';
    case 'failed': {
      const error = inlineError(stop.error);
      return `The merge could not be finished${error ? ` (${error})` : ''}.`;
    }
    case 'changed':
      return 'Your text changed while the merge was being saved, so the merged text was not applied.';
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
    // A version save can move the draft's counter: the machine takes it, and keeps what was typed meanwhile.
    autosave.refresh(draftOf(saved));
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

  /** Whether the reconciliation view is open, in place of the text, while the draft is in conflict. */
  const [reconciling, setReconciling] = useState(false);
  // Once the conflict is resolved, the next one starts with the banner again.
  if (reconciling && state.status !== 'conflict') setReconciling(false);

  /**
   * The reconciliation of this document's conflict. It outlives the editor: a confirmation keeps running after the
   * writer leaves, and its result and how it stopped are shown again when they come back.
   */
  const session = sessionFor({
    id: document.id,
    autosave,
    api,
    isConflict,
    onDocument: (saved) => {
      // The machine takes the draft from the cache, as from any read: after a stop, the view shows the newest text.
      queryClient.setQueryData(queryKeys.document(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) });
    },
  });
  const sessionState = useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    useCallback(() => session.getSnapshot(), [session]),
  );
  /** A merged text is being saved: the texts cannot change until it ends. */
  const busy = sessionState.running;
  /** Earlier texts of the merge, in no version, that neither the text nor the view shows. */
  const hidden = busy ? [] : hiddenTexts(sessionState, state);

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

  // Closing the page is guarded for every document at once, by `useAutosaveGuard` in the app.

  // An unreachable server is reported by the notification; the text stays here, and the autosave keeps trying.
  const actionError = inlineError(save.error ?? remove.error ?? overwrite.error);
  const { result: pendingResult, stop } = sessionState;
  /** The view replaces the text only while there is a conflict: once it is resolved, the text comes back. */
  const showReconciliation = reconciling && state.status === 'conflict';
  const historyLabel = showHistory ? 'Hide history' : 'History';
  const status = save.isPending ? 'Saving…' : statusText(state, document.revision, changedSinceVersion);

  return (
    <div className="editor-layout">
      <section className="editor">
        <div className="toolbar">
          {toolbarStart}
          <span
            className={state.status === 'saved' && !save.isPending ? 'status' : 'status dirty'}
            role="status"
            title={state.status === 'retrying' ? describeError(state.error) : status}
          >
            {status}
          </span>
          <span className="spacer" />
          <WritingStatsToggle open={showStats} onToggle={toggleStats} />
          <button
            className={showHistory ? 'toolbar-action active' : 'toolbar-action'}
            onClick={() => setShowHistory((value) => !value)}
            aria-label={historyLabel}
            aria-expanded={showHistory}
            title={historyLabel}
          >
            <HistoryIcon />
            <span className="toolbar-label">History</span>
          </button>
          <button
            className="toolbar-action danger"
            disabled={remove.isPending}
            onClick={() => window.confirm('Delete this document and its whole history?') && remove.mutate()}
            aria-label="Delete"
            title="Delete"
          >
            <TrashIcon />
            <span className="toolbar-label">Delete</span>
          </button>
          <button
            className="toolbar-action primary"
            disabled={!canSave}
            onClick={() => save.mutate()}
            aria-label="Save version"
            title="Save version (Ctrl+S)"
          >
            <SaveIcon />
            <span className="toolbar-label">Save version</span>
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
              {state.permanent
                ? isNotFound(state.error)
                  ? 'This document was deleted elsewhere: your text is no longer saved. Copy it before leaving.'
                  : `Your text can no longer be saved (${describeError(state.error)}). Copy it before leaving.`
                : `The server refused this text (${describeError(state.error)}). Change it to save again.`}
            </span>
          </div>
        ) : state.status === 'conflict' ? (
          busy ? (
            <div className="banner" role="status">
              <span>Saving the merged text…</span>
            </div>
          ) : stop !== undefined && pendingResult !== undefined ? (
            <div className={stop.reason === 'failed' ? 'banner error' : 'banner'} role="alert">
              <span>
                {stopText(stop)}{' '}
                {showReconciliation
                  ? 'It is kept below: retry it, or copy what you need and dismiss it.'
                  : 'It is kept: open the comparison to retry it or copy it.'}{' '}
                Your text is intact. Some versions may already have been kept in the history.
              </span>
              {!showReconciliation && (
                <button className="primary" onClick={() => setReconciling(true)}>
                  Compare and merge
                </button>
              )}
            </div>
          ) : (
            !showReconciliation && (
              <div className="banner" role="alert">
                <span>This text was also changed on another device.</span>
                <button className="primary" onClick={() => setReconciling(true)}>
                  Compare and merge
                </button>
              </div>
            )
          )
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

        {hidden.length > 0 && (
          <div className="held-texts">
            <p>
              The merge also holds {hidden.length === 1 ? 'this earlier text' : 'these earlier texts'}, in no version
              yet. Confirming a merge keeps {hidden.length === 1 ? 'it' : 'them'} as versions; copy what you need if you
              give up on it.
            </p>
            {hidden.map(({ text, side }) => (
              <HeldText key={text} label={earlierTextLabel(side)} text={text}>
                <button type="button" onClick={() => session.discardText(text)}>
                  Discard this text
                </button>
              </HeldText>
            ))}
          </div>
        )}

        {showReconciliation && state.status === 'conflict' ? (
          <div className="editor-reconcile">
            <ReconciliationView
              base={state.base.content}
              mine={state.content}
              theirs={state.server.content}
              mineLabel="This device"
              theirsLabel="Other device"
              busy={busy}
              previous={
                pendingResult === undefined || busy
                  ? undefined
                  : {
                      text: pendingResult,
                      onRetry: () => void session.confirm(pendingResult),
                      onDismiss: () => session.dismissResult(),
                    }
              }
              onConfirm={(result) => void session.confirm(result)}
              onCancel={() => setReconciling(false)}
            />
          </div>
        ) : (
          <>
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
              readOnly={busy}
              onChange={(event) => autosave.edit(event.target.value)}
              autoFocus
            />
          </>
        )}
      </section>

      {showHistory && (
        <RevisionHistory
          document={document}
          restoreDisabled={busy}
          onRestore={(revision) => {
            setTitle(revision.title ?? '');
            autosave.edit(revision.content);
          }}
        />
      )}
    </div>
  );
};
