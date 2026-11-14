import type { Document } from '@reviewr/shared';
import {
  ApiError,
  conflictOf,
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
import { cacheDocument, draftOf, isGone, useAutosave } from '../autosave/useAutosave';
import { ReconciliationView } from '../reconcile/ReconciliationView';
import { hiddenTexts, sessionFor, type Stop } from '../reconcile/session';
import { setUnsavedChanges } from '../unsavedChanges';
import { useLastRevisionBaseline, useTodayBaseline } from '../useTodayBaseline';
import { RevisionHistory } from './RevisionHistory';
import { earlierTextLabel, HeldText } from './TextRecovery';
import { ChevronIcon, HistoryIcon, SaveIcon, TrashIcon } from './ToolbarIcons';
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
  /** The cached title when the request started, to tell whether a rename was confirmed since. */
  title: string | null;
}

/** The text was changed before it was confirmed: the version would hold another text than the one asked for. */
const textMoved = new Error('The text changed while the version was being saved');

/** Why "Save version" created no version, when the draft itself was saved. */
const versionError = (error: unknown): string => {
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

export const Editor = ({ document, onDeleted, toolbarStart }: Props) => {
  const queryClient = useQueryClient();
  const { autosave, state, discard } = useAutosave(document);
  /**
   * The title as typed (empty when untitled), saved on its own by a rename. Every edit of the field is numbered, and
   * the field is saved only once the server confirmed a rename sent at its latest edit: an edit back to an earlier
   * title is an edit like any other, sent again, since an answer may arrive, or be lost, for the one before it.
   */
  const [title, setTitle] = useState(document.title ?? '');
  const [titleEdit, setTitleEdit] = useState(0);
  const [titleSaved, setTitleSaved] = useState(0);
  const titleDirty = titleSaved < titleEdit;
  const editTitle = (value: string) => {
    setTitle(value);
    setTitleEdit((edit) => edit + 1);
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
  /** Text that leaving the page could lose, even though the autosave keeps trying in the background. */
  const textAtRisk = state.status === 'retrying' || state.status === 'conflict' || state.status === 'rejected';

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

  // The title is saved soon after the writer stops typing; a failed rename is sent again after a while.
  useEffect(() => {
    if (!titleDirty || rename.isPending || titleWaits) return;
    const timer = setTimeout(() => sendTitle(title, titleEdit), titleRetry ? titleRetryMs : titleDebounceMs);
    return () => clearTimeout(timer);
  }, [title, titleEdit, titleDirty, rename.isPending, titleRetry, titleWaits, sendTitle]);

  /**
   * Saves a version: the draft first, then the server's draft of the counter the machine holds as confirmed becomes a
   * revision. Text typed meanwhile is not part of it: the autosave saves it as a draft. When the draft cannot be
   * saved, nothing more happens: the status says why.
   */
  const save = useMutation({
    mutationFn: async ({ name, text }: VersionRequest): Promise<Document | undefined> => {
      if ((await autosave.flush()) !== 'saved') return undefined;
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
    onSuccess: async (saved, { title: titleAtStart }) => {
      if (saved === undefined) return;
      // The answer may be older than a draft saved or a rename confirmed since the request started: those stay.
      if (!isGone(queryClient, saved.id)) {
        queryClient.setQueryData<Document>(queryKeys.document(saved.id), (cached) => {
          if (cached === undefined) return saved;
          if (cached.revision > saved.revision) return cached;
          const newerDraft = (cached.draft?.draftVersion ?? 0) > (saved.draft?.draftVersion ?? 0);
          return {
            ...saved,
            title: cached.title === titleAtStart ? saved.title : cached.title,
            draft: newerDraft ? cached.draft : saved.draft,
          };
        });
      }
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
    save.mutate({ name: trimmed === '' ? undefined : trimmed, text: content, title: document.title });
    if (versionName !== undefined) {
      setVersionName(undefined);
      textField.current?.focus();
    }
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
  const actionError = save.isError ? versionError(save.error) : inlineError(remove.error);
  const { result: pendingResult, stop } = sessionState;
  /** The view replaces the text only while there is a conflict: once it is resolved, the text comes back. */
  const showReconciliation = reconciling && state.status === 'conflict';
  const historyLabel = showHistory ? 'Hide history' : 'History';
  /** The text's state first; then the title's, while it is not saved. */
  const status = save.isPending
    ? 'Saving version…'
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
                if (titleDirty && !rename.isPending) sendTitle(title, titleEdit);
              }}
            />
            <textarea
              ref={textField}
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
            editTitle(revision.title ?? '');
            autosave.edit(revision.content);
          }}
        />
      )}
    </div>
  );
};
