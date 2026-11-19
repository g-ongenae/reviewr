import type { Document } from '@reviewr/shared';
import {
  ApiError,
  conflictOf,
  contentMaxLength,
  describeError,
  displayTitle,
  isServerUnreachable,
  revisionNameMaxLength,
  titleMaxLength,
  titleToSend,
} from '@reviewr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { api, inlineError, isConflict, isNotFound, queryKeys } from '../api';
import type { AutosaveState } from '../autosave/autosave';
import { deleteAsSeen } from '../autosave/autosave';
import {
  cacheDocument,
  discardAutosave,
  discardCopy,
  draftOf,
  isGone,
  useAutosave,
  useKeptCopies,
  usePagesNotCreated,
} from '../autosave/useAutosave';
import { cacheRename } from '../documentCache';
import { ReconciliationView } from '../reconcile/ReconciliationView';
import { hiddenTexts, sessionFor, type Stop } from '../reconcile/session';
import { cacheKeptVersion, restore, useRestore } from '../restore';
import { setUnsavedChanges } from '../unsavedChanges';
import { useLastRevisionBaseline, useTodayBaseline } from '../useTodayBaseline';
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

/** What "Save version" sends: the version's name, and the text on screen when the writer asked for it. */
interface VersionRequest {
  name: string | undefined;
  text: string;
}

/** The text was changed before it was confirmed: the version would hold another text than the one asked for. */
const textMoved = new Error('The text changed while the version was being saved');

/** "Save version" could not save the draft first: the server is unreachable, or the draft's save is being retried. */
const draftNotSaved = new Error('The draft could not be saved before the version');

/** Why "Save version" created no version. What to do next depends on the draft's state now, not at the click. */
const versionError = (error: unknown, draft: AutosaveState): string => {
  if (error === draftNotSaved) {
    // A retry got through since, or the writer typed again: nothing waits for the server any more.
    if (draft.status !== 'retrying') {
      return 'Version not saved: your text could not be saved at that moment. Save the version again.';
    }
    if (isServerUnreachable(draft.error)) {
      return 'Version not saved: the server is unreachable. Your text is kept; save the version again once it is back.';
    }
    const detail = inlineError(draft.error);
    return `Version not saved: your text could not be saved first${detail ? ` (${detail})` : ''}. It is kept and saved again on its own; save the version again once it is saved.`;
  }
  if (error === textMoved || conflictOf(error)?.code === 'draft_conflict') {
    return 'The version was not saved: the text changed while it was being saved. Your text is saved as a draft: save the version again to keep it.';
  }
  const detail = inlineError(error);
  return `The version could not be saved${detail ? ` (${detail})` : ''}. Your text is saved as a draft: try again.`;
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

export const Editor = ({ document, isNew = false, onOpenPage, onDeleted, toolbarStart }: Props) => {
  const queryClient = useQueryClient();
  const { autosave, state, discard, pendingTitle, keepTitle } = useAutosave(document, isNew);
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
  /** Every edit of the title field, counted for a restore, which never replaces a title typed while it runs. */
  const titleEdits = useRef(0);
  const editTitle = (value: string) => {
    titleEdits.current++;
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
  /** The restore from the history, one at a time: it outlives the panel, not the editor. */
  const restores = useRestore();
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
      if (!isGone(queryClient, saved.id)) cacheRename(queryClient, saved);
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

  /**
   * Saves a version: the draft first, then the server's draft of the counter the machine holds as confirmed becomes a
   * revision. Text typed meanwhile is not part of it: the autosave saves it as a draft. When the draft cannot be
   * saved, nothing more happens: the status says why.
   */
  const save = useMutation({
    mutationFn: async ({ name, text }: VersionRequest): Promise<Document | undefined> => {
      const flushed = await autosave.flush();
      // Nothing is queued: the writer is told, and saves the version again. A conflict or a refused text has its own status.
      if (flushed === 'failed') throw draftNotSaved;
      if (flushed !== 'saved') return undefined;
      // The flush may end on a later text, typed after the click and sent along with it: that one is not the version.
      const { draftVersion, content: confirmed } = autosave.getSnapshot().base;
      if (confirmed !== text) throw textMoved;
      let baseRevision = document.revision;
      // The head moved elsewhere, not the draft: that version stays in the history, and the draft is saved over it.
      for (let attempt = 1; ; attempt++) {
        try {
          return await api.createRevision(document.id, {
            name,
            draftVersion,
            baseRevision: baseRevision === 0 ? null : baseRevision,
          });
        } catch (error) {
          const conflict = conflictOf(error);
          if (conflict?.code !== 'stale_revision' || attempt === 3) throw error;
          baseRevision = conflict.revision;
        }
      }
    },
    onSuccess: async (saved) => {
      if (saved === undefined) return;
      // The answer may be older than a draft saved or a rename confirmed since the request started: those stay.
      cacheDocument(queryClient, saved);
      autosave.refresh(draftOf(saved));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) }),
      ]);
    },
    onError: (error) => {
      // The draft moved: the machine keeps the local text, and shows a conflict unless the draft holds that text.
      const conflict = conflictOf(error);
      if (conflict?.code === 'draft_conflict') autosave.refresh(conflict.draft, true);
    },
  });

  /** The name of the next version, while the writer gives one. */
  const [versionName, setVersionName] = useState<string | undefined>(undefined);
  const nameButton = useRef<HTMLButtonElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  /** Closes the name field; the keyboard goes back to the button that opened it. */
  const closeVersionName = () => {
    setVersionName(undefined);
    nameButton.current?.focus();
  };
  /** Saves the text on screen now as a version; the writer goes back to the text. */
  const saveVersion = (name?: string) => {
    const trimmed = name?.trim().slice(0, revisionNameMaxLength);
    remove.reset();
    setDeleteRefused(undefined);
    save.mutate({ name: trimmed === '' ? undefined : trimmed, text: content });
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

  /**
   * Deletes the document with the pair this screen showed when the confirmation opened (see `deleteAsSeen`). Until the
   * answer, this editor is frozen: no edit, version, restore or merge.
   */
  const remove = useMutation({
    mutationFn: (seen: { revision: number; draftVersion: number }) => api.deleteDocument(document.id, seen),
    onError: async (error) => {
      if (conflictOf(error)?.code !== 'document_changed') return;
      // Read it again through the normal path: a newer draft reaches the autosave, which never replaces unsaved text.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.document(document.id), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.revisions(document.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true }),
      ]);
    },
    onSuccess: async () => {
      discard();
      setUnsavedChanges(false);
      queryClient.removeQueries({ queryKey: queryKeys.document(document.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      onDeleted();
    },
  });

  /** A delete is waiting for its answer: this editor writes nothing meanwhile. */
  const frozen = remove.isPending;
  /** Why the last delete was not asked: the screen was not in a state to delete from. */
  const [deleteRefused, setDeleteRefused] = useState<string | undefined>(undefined);
  /** Takes the pair this render shows, then asks: whatever arrives while the dialog is open, the delete carries it. */
  const confirmDelete = () => {
    const decision = deleteAsSeen({
      state,
      revision: document.revision,
      writing: save.isPending || sessionState.running || restores.restoring !== undefined,
    });
    remove.reset();
    setDeleteRefused('refused' in decision ? decision.refused : undefined);
    if ('refused' in decision || !window.confirm('Delete this document and its whole history?')) return;
    save.reset();
    remove.mutate(decision.seen);
  };

  const canSave =
    !frozen &&
    changedSinceVersion &&
    // A blank page is never created: there is nothing to save as a version.
    (!isNew || content.trim() !== '') &&
    !save.isPending &&
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
  const actionError = save.isError ? versionError(save.error, state) : undefined;
  /** Why the last delete deleted nothing: shown above any other notice, until the writer does something else. */
  const deleteError = deleteRefused ?? inlineError(remove.error);
  const { result: pendingResult, stop } = sessionState;
  /** The view replaces the text only while there is a conflict: once it is resolved, the text comes back. */
  const showReconciliation = reconciling && state.status === 'conflict';
  const historyLabel = showHistory ? 'Hide history' : 'History';
  /** The text's state first; then the title's, while it is not saved. */
  const status = save.isPending
    ? 'Saving version…'
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
            className={state.status === 'saved' && !save.isPending && !titleDirty ? 'status' : 'status dirty'}
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
            onClick={confirmDelete}
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

        {deleteError && (
          <div className="banner error" role="alert">
            {deleteError}
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
                <button className="primary" disabled={frozen} onClick={() => setReconciling(true)}>
                  Compare and merge
                </button>
              )}
            </div>
          ) : (
            !showReconciliation && (
              <div className="banner" role="alert">
                <span>This text was also changed on another device.</span>
                <button className="primary" disabled={frozen} onClick={() => setReconciling(true)}>
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
              readOnly={frozen}
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
              readOnly={busy || frozen}
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
          restoreDisabled={busy || frozen}
          restoring={restores.restoring}
          notRestored={restores.notRestored}
          // The text on screen is first kept as a version when it is in no version: see `restore`.
          onRestore={(revision) =>
            restores.start(revision.revision, (active) =>
              restore({
                autosave,
                head: document,
                busy: () => session.getSnapshot().running,
                gone: () => isGone(queryClient, document.id),
                createRevision: (input) => api.createRevision(document.id, input),
                titleEdits: () => titleEdits.current,
                active,
                onKept: (saved) => cacheKeptVersion(queryClient, autosave, saved),
                apply: () => {
                  editTitle(revision.title ?? '');
                  autosave.edit(revision.content);
                },
              }),
            )
          }
        />
      )}
    </div>
  );
};
