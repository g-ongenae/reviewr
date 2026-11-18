import type { Document } from '@reviewr/shared';
import {
  ApiError,
  contentMaxLength,
  describeError,
  displayTitle,
  revisionNameMaxLength,
  titleMaxLength,
  titleToSend,
} from '@reviewr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { api, inlineError, isConflict, isNotFound, queryKeys } from '../api';
import type { AutosaveState } from '../autosave/autosave';
import {
  cacheDocument,
  discardAutosave,
  discardCopy,
  isGone,
  useAutosave,
  useKeptCopies,
  usePagesNotCreated,
} from '../autosave/useAutosave';
import { ReconciliationView } from '../reconcile/ReconciliationView';
import { hiddenTexts, sessionFor, type Stop } from '../reconcile/session';
import { setUnsavedChanges } from '../unsavedChanges';
import { useLastRevisionBaseline, useTodayBaseline } from '../useTodayBaseline';
import { HeldVersions, queuedStatus, useVersionQueue } from './QueuedVersions';
import { RevisionHistory } from './RevisionHistory';
import { earlierTextLabel, HeldText, keptCopyLabel } from './TextRecovery';
import { ChevronIcon, HistoryIcon, SaveIcon, TrashIcon } from './ToolbarIcons';
import { useWritingStatsPanel, WritingStatsPanel, WritingStatsToggle } from './WritingStats';

interface Props {
  document: Document;
  /** The document does not exist on the server yet (the blank page): the autosave creates it. */
  isNew?: boolean;
  /** Shows another page not created yet, `id`, on the blank page. */
  onOpenPage?: (id: string) => void;
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
      if (revision === 0) return 'No version yet · draft saved';
      return changedSinceVersion ? `Draft saved · changed since revision ${revision}` : `Saved · revision ${revision}`;
  }
};

/** The title to send for what is typed, and to compare with the server's: null when blank (untitled). */
const titleValue = (typed: string | null): string | null => titleToSend(typed ?? '') ?? null;

/** How long the title waits after the last keystroke before it is saved, and before a failed rename is sent again. */
const titleDebounceMs = 800;
const titleRetryMs = 5000;

/** Whether the server refused a rename (a 4xx): sending the same title again cannot help, a changed one may. */
const refused = (error: unknown): boolean => error instanceof ApiError && error.status < 500;

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

export const Editor = ({ document, isNew = false, onOpenPage, onDeleted, toolbarStart }: Props) => {
  const queryClient = useQueryClient();
  const { autosave, state, discard, pendingTitle, keepTitle, versions } = useAutosave(document, isNew);
  /** The versions saved while the server was unreachable: they wait for it, or are held for the writer. */
  const { pending: queuedVersions } = useVersionQueue(versions);
  /**
   * The title as typed (empty when untitled), saved on its own by a rename. Every edit of the field is numbered, and
   * the field is saved only once the server confirmed a rename sent at its latest edit: an edit back to an earlier
   * title is an edit like any other, sent again, since an answer may arrive, or be lost, for the one before it.
   */
  // A title typed before the document existed, on an earlier editor of this page, is still to be saved.
  const [title, setTitle] = useState(() => (isNew ? pendingTitle : undefined) ?? document.title ?? '');
  const [titleEdit, setTitleEdit] = useState(isNew && pendingTitle !== undefined ? 1 : 0);
  const [titleSaved, setTitleSaved] = useState(0);
  const titleDirty = titleSaved < titleEdit;
  const editTitle = (value: string) => {
    setTitle(value);
    setTitleEdit((edit) => edit + 1);
    if (isNew) keepTitle(value);
  };
  /** The server's title as last read or confirmed: a new one replaces the field only when no edit is unsaved. */
  const [serverTitle, setServerTitle] = useState(document.title);
  if (document.title !== serverTitle) {
    if (!titleDirty) setTitle(document.title ?? '');
    setServerTitle(document.title);
  }
  const { content } = state;
  const [showHistory, setShowHistory] = useState(false);
  const [showStats, toggleStats] = useWritingStatsPanel();
  const todayBaseline = useTodayBaseline(document);
  const previousRevision = useLastRevisionBaseline(document);
  /** Whether "Save version" has something to save. */
  const changedSinceVersion = content !== document.content;
  /**
   * Text that leaving the page could lose, even though the autosave keeps trying in the background. A text whose
   * document is not created yet is in no list: only this blank page leads back to it.
   */
  const textAtRisk =
    state.status === 'retrying' ||
    state.status === 'conflict' ||
    state.status === 'rejected' ||
    (isNew && content.trim() !== '');

  /** Renames the document: no version, the content and the draft are left alone. */
  const rename = useMutation({
    mutationFn: ({ value }: { value: string | null; edit: number }) => api.renameDocument(document.id, value),
    onSuccess: async (saved, { edit }) => {
      setTitleSaved((confirmed) => Math.max(confirmed, edit));
      const key = queryKeys.document(saved.id);
      // A read sent before this answer may still hold the old title: drop it, then read again.
      const reading = queryClient.isFetching({ queryKey: key, exact: true }) > 0;
      if (reading) await queryClient.cancelQueries({ queryKey: key, exact: true });
      // Only the title: the answer's draft may be older than one saved since.
      if (!isGone(queryClient, saved.id)) {
        queryClient.setQueryData<Document>(key, (cached) => cached && { ...cached, title: saved.title });
      }
      if (reading) void queryClient.invalidateQueries({ queryKey: key, exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
    },
  });
  const { mutate } = rename;
  const sendTitle = useCallback((value: string, edit: number) => mutate({ value: titleValue(value), edit }), [mutate]);
  const titleRetry = rename.isError && rename.variables.edit === titleEdit;
  /** A title refused as it is waits for a change or for the field to lose focus. */
  const titleWaits = titleRetry && refused(rename.error);

  // The title is saved soon after the writer stops typing, once the document exists; a failed rename is sent again
  // after a while.
  useEffect(() => {
    if (isNew || !titleDirty || rename.isPending || titleWaits) return;
    const timer = setTimeout(() => sendTitle(title, titleEdit), titleRetry ? titleRetryMs : titleDebounceMs);
    return () => clearTimeout(timer);
  }, [isNew, title, titleEdit, titleDirty, rename.isPending, titleRetry, titleWaits, sendTitle]);

  /** The name of the next version, while the writer gives one. */
  const [versionName, setVersionName] = useState<string | undefined>(undefined);
  const nameButton = useRef<HTMLButtonElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  /** Closes the name field; the keyboard goes back to the button that opened it. */
  const closeVersionName = () => {
    setVersionName(undefined);
    nameButton.current?.focus();
  };
  /**
   * Saves the text on screen now as a version; the writer goes back to the text. The text and the name are queued at the
   * click, in order with every other version: the autosave machine creates the version at once when the server is
   * reachable, once it is back otherwise (see `versionQueue`), and the text typed since is saved as a draft after it.
   */
  const saveVersion = (name?: string) => {
    const trimmed = name?.trim().slice(0, revisionNameMaxLength);
    versions.enqueue({ name: trimmed === '' ? undefined : trimmed, text: content });
    void autosave.flush();
    if (versionName !== undefined) {
      setVersionName(undefined);
      textField.current?.focus();
    }
  };

  /** The blank page, nothing typed yet: it welcomes the writer. */
  const welcome = isNew && content === '' && title === '';

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
      cacheDocument(queryClient, saved);
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
  /** Other texts that tabs closed before saving left on this device for this document. */
  const copies = useKeptCopies(document.id).filter((text) => text !== content);
  /** The other pages not created yet, which only the blank page leads to. */
  const otherPages = usePagesNotCreated(document.id);
  const pages = isNew ? otherPages : [];

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

  const canSave =
    changedSinceVersion &&
    // A blank page is never created: there is nothing to save as a version.
    (!isNew || content.trim() !== '') &&
    state.status !== 'conflict' &&
    state.status !== 'rejected';
  const saveNow = useEffectEvent(() => {
    if (canSave) saveVersion(versionName);
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

  // Switching document keeps saving the text in the background: ask only when it is at risk, or for a title not saved.
  useEffect(() => setUnsavedChanges(titleDirty || textAtRisk), [titleDirty, textAtRisk]);
  useEffect(() => () => setUnsavedChanges(false), []);

  // Closing the page is guarded for every document at once, by `useAutosaveGuard` in the app.

  // An unreachable server is reported by the notification; the text stays here, and the autosave keeps trying.
  const actionError = inlineError(remove.error);
  const { result: pendingResult, stop } = sessionState;
  /** The view replaces the text only while there is a conflict: once it is resolved, the text comes back. */
  const showReconciliation = reconciling && state.status === 'conflict';
  const historyLabel = showHistory ? 'Hide history' : 'History';
  /** The text's state first; then the title's, while it is not saved. */
  const status =
    queuedVersions.length > 0
      ? queuedStatus(queuedVersions, state.status === 'retrying')
      : isNew && state.status === 'saved'
        ? // The blank page: nothing typed yet, or only a title, saved with the text once there is one.
          titleDirty
          ? 'Unsaved changes'
          : ''
        : state.status !== 'saved' || !titleDirty
          ? statusText(state, document.revision, changedSinceVersion)
          : titleRetry
            ? `Title not saved${titleWaits ? '' : ' · retrying'}`
            : 'Saving title…';
  const statusTooltip =
    state.status === 'retrying' ? describeError(state.error) : titleRetry ? describeError(rename.error) : status;

  return (
    <div className="editor-layout">
      <section className="editor">
        <div className="toolbar">
          {toolbarStart}
          <span
            className={
              state.status === 'saved' && !titleDirty && queuedVersions.length === 0 ? 'status' : 'status dirty'
            }
            role="status"
            title={statusTooltip}
          >
            {status}
          </span>
          <span className="spacer" />
          <WritingStatsToggle open={showStats} onToggle={toggleStats} />
          <button
            className={showHistory ? 'toolbar-action active' : 'toolbar-action'}
            disabled={isNew}
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
            disabled={isNew || remove.isPending}
            onClick={() => window.confirm('Delete this document and its whole history?') && remove.mutate()}
            aria-label="Delete"
            title="Delete"
          >
            <TrashIcon />
            <span className="toolbar-label">Delete</span>
          </button>
          <div className="split-action">
            <button
              className="toolbar-action primary"
              disabled={!canSave}
              onClick={() => saveVersion()}
              aria-label="Save version"
              title="Save version (Ctrl+S)"
            >
              <SaveIcon />
              <span className="toolbar-label">Save version</span>
            </button>
            <button
              ref={nameButton}
              className={versionName === undefined ? 'toolbar-action primary' : 'toolbar-action primary active'}
              disabled={!canSave && versionName === undefined}
              onClick={() => setVersionName((name) => (name === undefined ? '' : undefined))}
              aria-label="Name this version"
              aria-expanded={versionName !== undefined}
              title="Name this version"
            >
              <ChevronIcon />
            </button>
          </div>
        </div>

        {versionName !== undefined && (
          <form
            className="version-name-form"
            aria-label="Name this version"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) saveVersion(versionName);
            }}
          >
            <input
              aria-label="Version name"
              placeholder="Name this version (optional)"
              value={versionName}
              maxLength={revisionNameMaxLength}
              autoFocus
              onChange={(event) => setVersionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeVersionName();
                }
              }}
            />
            <button type="button" onClick={closeVersionName}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!canSave}>
              Save
            </button>
          </form>
        )}

        {showStats && (
          <div className="writing-stats-anchor">
            <WritingStatsPanel
              content={content}
              baseline={todayBaseline}
              // No version yet: nothing to compare with.
              lastRevision={
                document.revision === 0 ? undefined : { content: document.content, previous: previousRevision }
              }
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
        ) : (
          actionError && (
            <div className="banner error" role="status">
              {actionError}
            </div>
          )
        )}

        <HeldVersions queue={versions} />

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

        {copies.length > 0 && (
          <div className="held-texts">
            <p>
              {copies.length === 1
                ? 'This device also kept another copy of this text, which was not saved.'
                : 'This device also kept other copies of this text, which were not saved.'}{' '}
              Copy what you need, then discard {copies.length === 1 ? 'it' : 'them'}.
            </p>
            {copies.map((text) => (
              <HeldText key={text} label={keptCopyLabel} text={text}>
                <button type="button" onClick={() => discardCopy(queryClient, document.id, text)}>
                  Discard this copy
                </button>
              </HeldText>
            ))}
          </div>
        )}

        {pages.length > 0 && (
          <div className="held-texts">
            <p>
              {pages.length === 1
                ? 'This device also keeps another page, not saved yet.'
                : 'This device also keeps other pages, not saved yet.'}{' '}
              Open one to go on writing it, or copy it; discarding removes it from this device.
            </p>
            {pages.map((page) => (
              <HeldText key={page.id} label={page.title?.trim() || 'A page not saved yet'} text={page.content}>
                <button type="button" onClick={() => onOpenPage?.(page.id)}>
                  Open this page
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm('Discard this page? Its text is removed from this device.')) {
                      discardAutosave(queryClient, page.id);
                    }
                  }}
                >
                  Discard this page
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
              onChange={(event) => editTitle(event.target.value)}
              onBlur={() => {
                if (!isNew && titleDirty && !rename.isPending) sendTitle(title, titleEdit);
              }}
            />
            <textarea
              ref={textField}
              className="content-input"
              // The blank page's welcome already invites to write.
              placeholder={welcome ? undefined : 'Start writing…'}
              value={content}
              maxLength={contentMaxLength}
              readOnly={busy}
              onChange={(event) => autosave.edit(event.target.value)}
              autoFocus
            />
            {welcome && (
              <div className="blank-page-welcome" aria-hidden="true">
                <h1>What do you want to tell today?</h1>
                <p>Or start reviewing an existing text from the sidebar.</p>
              </div>
            )}
          </>
        )}
      </section>

      {showHistory && (
        <RevisionHistory
          document={document}
          restoreDisabled={busy}
          onRestore={(revision) => {
            editTitle(revision.title ?? '');
            autosave.edit(revision.content);
          }}
        />
      )}
    </div>
  );
};
