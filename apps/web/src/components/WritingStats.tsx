import type { ReactNode } from 'react';
import { useDeferredValue, useMemo } from 'react';
import { countWords } from '../format';
import { useStoredBoolean } from '../useStoredBoolean';
import type { TodayBaseline } from '../useTodayBaseline';
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

interface PanelProps {
  content: string;
  /** What the text was when today began. */
  baseline: TodayBaseline;
}

const pendingText = { loading: '…', unavailable: '—' } as const;
const pendingTitle = {
  loading: 'Loading the last version saved before today…',
  unavailable: 'Needs the last version saved before today: available once the server is reachable.',
} as const;

/** Size of the text and how much of it was written today. */
export const WritingStatsPanel = ({ content, baseline }: PanelProps) => {
  // Counting runs on a deferred copy of the text, so typing never waits for it.
  const text = useDeferredValue(content);
  const baselineText = baseline.status === 'ready' ? baseline.content : undefined;
  const words = useMemo(() => countWords(text), [text]);
  const characters = useMemo(() => countCharacters(text), [text]);
  const baselineWords = useMemo(() => (baselineText === undefined ? 0 : countWords(baselineText)), [baselineText]);
  const changes = useMemo(
    () => (baselineText === undefined ? undefined : countCharacterChanges(baselineText, text)),
    [baselineText, text],
  );

  const today = (value: ReactNode, title: string) =>
    baseline.status === 'ready' ? (
      <dd title={title}>{value}</dd>
    ) : (
      <dd className="muted" title={pendingTitle[baseline.status]}>
        {pendingText[baseline.status]}
      </dd>
    );

  return (
    <aside id={panelId} className="writing-stats" aria-label="Writing stats">
      <section>
        <h2>Words</h2>
        <dl>
          <dt>Total</dt>
          <dd>{numberFormat.format(words)}</dd>
          <dt>Today</dt>
          {today(
            signed(words - baselineWords),
            'Net change since the start of the day: negative when words were removed.',
          )}
        </dl>
      </section>
      <section>
        <h2>Characters</h2>
        <dl>
          <dt>Total</dt>
          <dd title="Including spaces and line breaks">{numberFormat.format(characters)}</dd>
          <dt>Today</dt>
          {today(
            <>
              <span className="added">+{numberFormat.format(changes?.added ?? 0)}</span>
              <span className="deleted">−{numberFormat.format(changes?.deleted ?? 0)}</span>
            </>,
            'Characters written / deleted since the start of the day',
          )}
        </dl>
      </section>
    </aside>
  );
};
