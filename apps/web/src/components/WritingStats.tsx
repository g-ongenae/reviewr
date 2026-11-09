import type { ReactNode } from 'react';
import { useDeferredValue, useMemo } from 'react';
import { countWords } from '../format';
import { useStoredBoolean } from '../useStoredBoolean';
import type { Baseline } from '../useTodayBaseline';
import { countCharacterChanges, countCharacters } from '../writingStats';

const panelId = 'writing-stats';
const numberFormat = new Intl.NumberFormat('en');
const signedFormat = new Intl.NumberFormat('en', { signDisplay: 'exceptZero' });
/** Typographic minus, so negative numbers line up with positive ones. */
const signed = (value: number) => signedFormat.format(value).replace('-', '−');

/** Whether the writing stats panel is shown. Remembered across reloads and shared by every document. */
export const useWritingStatsPanel = () => useStoredBoolean('reviewr.writingStatsOpen', true);

interface ToggleProps {
  open: boolean;
  onToggle: () => void;
}

export const WritingStatsToggle = ({ open, onToggle }: ToggleProps) => {
  const label = open ? 'Hide writing stats' : 'Show writing stats';
  return (
    <button
      className={open ? 'icon-button active' : 'icon-button'}
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls={panelId}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M8 16v-4M12 16V8M16 16v-6" />
      </svg>
    </button>
  );
};

/** What the last save changed: the saved text, measured against the revision before it. */
export interface LastRevision {
  content: string;
  previous: Baseline;
}

interface PanelProps {
  content: string;
  /** What the text was when today began. */
  baseline: Baseline;
  /** Omitted for a text that was never saved. */
  lastRevision?: LastRevision;
}

const pendingText = { loading: '…', unavailable: '—' } as const;
const pendingTitle = {
  today: {
    loading: 'Loading the last version saved before today…',
    unavailable: 'Needs the last version saved before today: available once the server is reachable.',
  },
  lastRevision: {
    loading: 'Loading the previous revision…',
    unavailable: 'Needs the previous revision: available once the server is reachable.',
  },
} as const;

interface Changes {
  /** Net change in words: negative when words were removed. */
  words: number;
  added: number;
  deleted: number;
}

/** What changed from `before` to `after`, or undefined while `before` is not known. */
const useChanges = (before: Baseline | undefined, after: string): Changes | undefined => {
  const beforeText = before?.status === 'ready' ? before.content : undefined;
  return useMemo(
    () =>
      beforeText === undefined
        ? undefined
        : { words: countWords(after) - countWords(beforeText), ...countCharacterChanges(beforeText, after) },
    [beforeText, after],
  );
};

/** Size of the text, how much of it was written today, and what the last save changed. */
export const WritingStatsPanel = ({ content, baseline, lastRevision }: PanelProps) => {
  // Counting runs on a deferred copy of the text, so typing never waits for it.
  const text = useDeferredValue(content);
  const words = useMemo(() => countWords(text), [text]);
  const characters = useMemo(() => countCharacters(text), [text]);
  const today = useChanges(baseline, text);
  const last = useChanges(lastRevision?.previous, lastRevision?.content ?? '');

  const row = (
    label: string,
    source: Baseline,
    titles: (typeof pendingTitle)[keyof typeof pendingTitle],
    value: ReactNode,
    title: string,
  ) => (
    <>
      <dt>{label}</dt>
      {source.status === 'ready' ? (
        <dd title={title}>{value}</dd>
      ) : (
        <dd className="muted" title={titles[source.status]}>
          {pendingText[source.status]}
        </dd>
      )}
    </>
  );

  const characterChanges = (changes: Changes | undefined) => (
    <>
      <span className="added">+{numberFormat.format(changes?.added ?? 0)}</span>
      <span className="deleted">−{numberFormat.format(changes?.deleted ?? 0)}</span>
    </>
  );

  return (
    <aside id={panelId} className="writing-stats" aria-label="Writing stats">
      <section>
        <h2>Words</h2>
        <dl>
          <dt>Total</dt>
          <dd>{numberFormat.format(words)}</dd>
          {row(
            'Today',
            baseline,
            pendingTitle.today,
            signed(today?.words ?? 0),
            'Net change since the start of the day: negative when words were removed.',
          )}
          {lastRevision &&
            row(
              'Last revision',
              lastRevision.previous,
              pendingTitle.lastRevision,
              signed(last?.words ?? 0),
              'Net change made by the last save: negative when words were removed.',
            )}
        </dl>
      </section>
      <section>
        <h2>Characters</h2>
        <dl>
          <dt>Total</dt>
          <dd title="Including spaces and line breaks">{numberFormat.format(characters)}</dd>
          {row(
            'Today',
            baseline,
            pendingTitle.today,
            characterChanges(today),
            'Characters written / deleted since the start of the day',
          )}
          {lastRevision &&
            row(
              'Last revision',
              lastRevision.previous,
              pendingTitle.lastRevision,
              characterChanges(last),
              'Characters written / deleted by the last save',
            )}
        </dl>
      </section>
    </aside>
  );
};
