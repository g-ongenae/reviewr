import type { ChangePart, ConflictResolution } from '@reviewr/merge';
import { useEffect, useRef, useState } from 'react';
import {
  createReconciliation,
  dismissOrphan,
  handWritten,
  isResolved,
  keepEarlierChoice,
  nextFocus,
  recompute,
  remaining,
  resolutionText,
  resolveConflict,
  resolvedText,
  toParagraphs,
  type ConflictEntry,
  type FocusTarget,
  type Reconciliation,
} from './reconcile';
import './reconcile.css';

export interface ReconciliationViewProps {
  /** The text both sides started from. */
  base: string;
  /** This device's text. */
  mine: string;
  /** The server's text; when it changes while the view is open, the merge is computed again. */
  theirs: string;
  /** How each side is named to the writer, for example "This device" and "Other device". */
  mineLabel: string;
  theirsLabel: string;
  /** Receives the reconciled text. Nothing is applied before. */
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

interface Labels {
  mine: string;
  theirs: string;
}

const sideClass = { mine: 'by-mine', theirs: 'by-theirs', both: 'by-both' } as const;

/**
 * Shows a three-way merge of `base`, `mine` and `theirs` in reading order: the changes that don't overlap already
 * applied and attributed to their side, each conflict marked in the text, with its choices (keep one side, both, or
 * edit by hand) right after the paragraph that holds it.
 */
export const ReconciliationView = ({
  base,
  mine,
  theirs,
  mineLabel,
  theirsLabel,
  onConfirm,
  onCancel,
}: ReconciliationViewProps) => {
  const [state, setState] = useState<Reconciliation>(() => createReconciliation(base, mine, theirs));
  // Derived from props: a new `theirs` merges again during render, keeping what the writer did (see `recompute`).
  if (state.base !== base || state.mine !== mine || state.theirs !== theirs) {
    setState(recompute(state, base, mine, theirs));
  }
  const labels: Labels = { mine: mineLabel, theirs: theirsLabel };
  const left = remaining(state);
  const text = resolvedText(state);
  const changedAgain = state.lostChoices > 0 || state.conflicts.some((entry) => entry.recheck);

  // After a choice, move the focus on, so the conflicts can be worked through with the keyboard alone.
  const root = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<string | null>(null);
  useEffect(() => {
    if (focusTarget.current === null) return;
    root.current?.querySelector<HTMLElement>(focusTarget.current)?.focus();
    focusTarget.current = null;
  });

  /** Applies a change of state and sends the focus to what blocks the confirmation next. */
  const advance = (next: Reconciliation, from: number) => {
    setState(next);
    const target: FocusTarget = nextFocus(next, from);
    focusTarget.current =
      target === 'confirm'
        ? '.reconcile-confirm'
        : 'conflict' in target
          ? `[data-conflict="${target.conflict}"] h3`
          : `[data-orphan="${target.orphan}"] textarea`;
  };

  const choose = (index: number, resolution: ConflictResolution) => {
    const next = resolveConflict(state, index, resolution);
    if (resolution === 'mine' || resolution === 'theirs') {
      advance(next, index);
    } else {
      setState(next);
      focusTarget.current = `[data-conflict="${index}"] textarea`;
    }
  };

  return (
    <div className="reconcile" ref={root}>
      <header className="reconcile-header">
        <h2>Both versions changed</h2>
        <p className="muted">
          Changes that don’t overlap are already applied. Where they do, choose what to keep. Nothing is saved until you
          confirm.
        </p>
        <ul className="reconcile-legend" aria-label="Legend">
          {[
            { side: 'by-mine', label: labels.mine },
            { side: 'by-theirs', label: labels.theirs },
            { side: 'by-both', label: 'Both' },
          ].map(({ side, label }) => (
            <li key={side} className={side}>
              <span>{label}</span>
              <ins>added</ins>
              <del>removed</del>
            </li>
          ))}
        </ul>
      </header>

      {changedAgain && (
        <p className="reconcile-notice" role="status">
          {labels.theirs} changed the text again while this view was open. The passages marked “Changed again” need
          another look.
        </p>
      )}

      {state.orphans.map((orphan, index) => (
        <section
          key={index}
          className="reconcile-orphan"
          data-orphan={index}
          aria-label="Hand-written text without a place"
        >
          <p>
            You wrote this by hand for a passage that has changed again and no longer exists as such. Copy what you need
            into a passage below, then dismiss it.
          </p>
          <textarea readOnly value={orphan} aria-label="Your earlier hand-written text" rows={3} />
          <button type="button" onClick={() => advance(dismissOrphan(state, index), -1)}>
            Dismiss
          </button>
        </section>
      ))}

      <div className="reconcile-text">
        {toParagraphs(state.merge).map((runs, key) => (
          <div key={key}>
            <p>
              {runs.map((run, i) =>
                run.kind === 'text' ? (
                  run.text
                ) : run.kind === 'change' ? (
                  <Change key={i} part={run.part} labels={labels} />
                ) : (
                  <ConflictMark key={i} index={run.index} entry={state.conflicts[run.index]} labels={labels} />
                ),
              )}
            </p>
            {runs.map((run) => {
              if (run.kind !== 'conflict') return null;
              const entry = state.conflicts[run.index];
              if (entry === undefined) return null;
              const index = run.index;
              return (
                <Conflict
                  key={index}
                  index={index}
                  total={state.conflicts.length}
                  entry={entry}
                  labels={labels}
                  onChoose={(resolution) => choose(index, resolution)}
                  onEdit={(edit) => setState(resolveConflict(state, index, { edit }))}
                  onKeepEarlier={() => advance(keepEarlierChoice(state, index), index)}
                />
              );
            })}
          </div>
        ))}
      </div>

      <footer className="reconcile-footer">
        <span className="reconcile-remaining" role="status">
          {left === 0
            ? 'Everything is resolved.'
            : left === 1
              ? '1 conflict left to resolve'
              : `${left} conflicts left to resolve`}
        </span>
        <span className="spacer" />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary reconcile-confirm"
          disabled={text === undefined}
          onClick={() => text !== undefined && onConfirm(text)}
        >
          Confirm
        </button>
      </footer>
    </div>
  );
};

/** Text as one side changed it: what it removed, struck through, then what it added, underlined in its side's style. */
const Edit = ({ removed, added, side }: { removed: string; added: string; side: string }) => (
  <>
    {removed !== '' && (
      <del>
        <span className="visually-hidden">Removed by {side}: </span>
        {removed}
      </del>
    )}
    {added !== '' && (
      <ins>
        <span className="visually-hidden">Added by {side}: </span>
        {added}
      </ins>
    )}
  </>
);

/** A change already applied. */
const Change = ({ part, labels }: { part: ChangePart; labels: Labels }) => {
  const side = part.kind === 'both' ? 'both sides' : labels[part.kind];
  return (
    <span className={sideClass[part.kind]} title={side}>
      <Edit removed={part.base} added={part.text} side={side} />
    </span>
  );
};

/** A conflict in the running text: its number, then each side's version, or the text chosen once it is resolved. */
const ConflictMark = ({ index, entry, labels }: { index: number; entry?: ConflictEntry; labels: Labels }) => {
  if (entry === undefined) return null;
  const { part, resolution } = entry;
  return (
    <span className={`reconcile-mark${isResolved(entry) ? ' resolved' : ''}`}>
      <span className="reconcile-number" aria-hidden="true">
        {index + 1}
      </span>
      {isResolved(entry) && resolution !== undefined ? (
        resolutionText(part, resolution) === '' ? (
          <del>
            <span className="visually-hidden">Removed: </span>
            {part.base}
          </del>
        ) : (
          <span>
            <span className="visually-hidden">Chosen text: </span>
            {resolutionText(part, resolution)}
          </span>
        )
      ) : (
        <>
          <span className="by-mine" title={labels.mine}>
            <Edit removed={part.mine === '' ? part.base : ''} added={part.mine} side={labels.mine} />
          </span>
          <span className="reconcile-or" aria-hidden="true">
            {' / '}
          </span>
          <span className="by-theirs" title={labels.theirs}>
            <Edit removed={part.theirs === '' ? part.base : ''} added={part.theirs} side={labels.theirs} />
          </span>
        </>
      )}
    </span>
  );
};

interface ConflictProps {
  index: number;
  total: number;
  entry: ConflictEntry;
  labels: Labels;
  onChoose: (resolution: ConflictResolution) => void;
  onEdit: (text: string) => void;
  onKeepEarlier: () => void;
}

/** The choices for one conflict, shown after the paragraph that holds it. */
const Conflict = ({ index, total, entry, labels, onChoose, onEdit, onKeepEarlier }: ConflictProps) => {
  const { part, resolution } = entry;
  const editing = resolution === 'both' || typeof resolution === 'object';
  const titleId = `reconcile-conflict-${index}`;
  const current = resolution === undefined ? undefined : resolutionText(part, resolution);
  const sides = [
    { side: 'mine', label: labels.mine },
    { side: 'theirs', label: labels.theirs },
  ] as const;

  return (
    <section
      className={`reconcile-conflict${isResolved(entry) ? ' resolved' : ''}`}
      data-conflict={index}
      aria-labelledby={titleId}
    >
      <h3 id={titleId} tabIndex={-1}>
        Conflict {index + 1} of {total}
        {isResolved(entry) && <span className="reconcile-tag">Resolved</span>}
        {entry.recheck && <span className="reconcile-tag recheck">Changed again</span>}
      </h3>
      <div className="reconcile-actions" role="group" aria-label="Resolve">
        {sides.map(({ side, label }) => (
          <button
            key={side}
            type="button"
            className={sideClass[side]}
            aria-pressed={resolution === side}
            onClick={() => onChoose(side)}
          >
            Keep <span className="reconcile-side-name">{label}</span>
          </button>
        ))}
        <button type="button" aria-pressed={resolution === 'both'} onClick={() => onChoose('both')}>
          Keep both
        </button>
        <button
          type="button"
          aria-pressed={typeof resolution === 'object'}
          onClick={() => onChoose({ edit: handWritten(entry) ?? current ?? part.mine })}
        >
          Edit by hand
        </button>
        {entry.recheck && resolution !== undefined && (
          <button type="button" onClick={onKeepEarlier}>
            Keep my earlier choice
          </button>
        )}
      </div>
      {entry.recheck && (
        <p className="reconcile-recheck">
          {labels.theirs} changed this passage again. Your earlier choice is kept: check it before confirming.
        </p>
      )}
      {editing && current !== undefined && (
        <label className="reconcile-edit">
          <span>
            {resolution === 'both'
              ? 'Both texts, joined exactly as written. Add a space or a line break where they meet if needed.'
              : 'Your text for this passage'}
          </span>
          <textarea
            value={current}
            rows={Math.min(8, Math.max(2, Math.ceil(current.length / 60)))}
            onChange={(event) => onEdit(event.target.value)}
          />
        </label>
      )}
    </section>
  );
};
