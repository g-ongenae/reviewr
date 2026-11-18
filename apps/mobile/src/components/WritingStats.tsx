import { countCharacterChanges, countCharacters, countWords, formatChange, formatCount } from '@reviewr/merge';
import type { Baseline } from '@reviewr/shared';
import type { ReactNode } from 'react';
import { useDeferredValue, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type Theme, useTheme } from '@/lib/theme';

/**
 * The web's writing stats panel (apps/web/src/components/WritingStats.tsx) at phone width: the same sections, rows,
 * numbers and signs, counted by the same code.
 */

/** What the last save changed: the saved text, measured against the revision before it. */
export interface LastRevision {
  content: string;
  previous: Baseline;
}

type Props = {
  content: string;
  /** What the text was when today began. */
  baseline: Baseline;
  /** Omitted for a text that was never saved as a version. */
  lastRevision?: LastRevision;
};

const pendingText = { loading: '…', unavailable: '—' } as const;
/** The web shows these as tooltips; screen readers say them here. */
const pendingLabel = {
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

const Row = ({ label, value, theme }: { label: string; value: ReactNode; theme: Theme }) => (
  <View style={styles.row}>
    <Text style={[styles.text, styles.label, { color: theme.muted }]}>{label}</Text>
    <View style={styles.value}>{value}</View>
  </View>
);

/** Size of the text, how much of it was written today, and what the last save changed. */
export const WritingStatsPanel = ({ content, baseline, lastRevision }: Props) => {
  const theme = useTheme();
  // Counting runs on a deferred copy of the text, so typing never waits for it.
  const text = useDeferredValue(content);
  const words = useMemo(() => countWords(text), [text]);
  const characters = useMemo(() => countCharacters(text), [text]);
  const today = useChanges(baseline, text);
  const last = useChanges(lastRevision?.previous, lastRevision?.content ?? '');

  const number = (value: string, color = theme.text) => (
    <Text style={[styles.text, styles.number, { color }]}>{value}</Text>
  );

  /** A row measured against `source`: "…" while it loads, "—" when it cannot be read. */
  const pendingRow = (
    label: string,
    source: Baseline,
    labels: (typeof pendingLabel)[keyof typeof pendingLabel],
    value: () => ReactNode,
  ) => (
    <Row
      key={label}
      label={label}
      theme={theme}
      value={
        source.status === 'ready' ? (
          value()
        ) : (
          <Text accessibilityLabel={labels[source.status]} style={[styles.text, styles.number, { color: theme.muted }]}>
            {pendingText[source.status]}
          </Text>
        )
      }
    />
  );

  const characterChanges = (changes: Changes | undefined) => (
    <>
      {number(`+${formatCount(changes?.added ?? 0)}`)}
      {number(`−${formatCount(changes?.deleted ?? 0)}`, theme.muted)}
    </>
  );

  const section = (title: string, rows: ReactNode, first: boolean) => (
    <View style={[styles.section, !first && { borderLeftWidth: 1, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.muted }]}>
        {title}
      </Text>
      {rows}
    </View>
  );

  return (
    <View
      accessibilityLabel="Writing stats"
      style={[styles.panel, { borderColor: theme.border, backgroundColor: theme.card }]}
    >
      {section(
        'Words',
        <>
          <Row label="Total" theme={theme} value={number(formatCount(words))} />
          {pendingRow('Today', baseline, pendingLabel.today, () => number(formatChange(today?.words ?? 0)))}
          {lastRevision &&
            pendingRow('Last revision', lastRevision.previous, pendingLabel.lastRevision, () =>
              number(formatChange(last?.words ?? 0)),
            )}
        </>,
        true,
      )}
      {section(
        'Characters',
        <>
          <Row label="Total" theme={theme} value={number(formatCount(characters))} />
          {pendingRow('Today', baseline, pendingLabel.today, () => characterChanges(today))}
          {lastRevision &&
            pendingRow('Last revision', lastRevision.previous, pendingLabel.lastRevision, () => characterChanges(last))}
        </>,
        false,
      )}
    </View>
  );
};

// The web's sizes, in its rem of 16 px: a 0.85 rem text, 0.7 rem headings, rows 0.2 rem apart.
const styles = StyleSheet.create({
  panel: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderRadius: 10 },
  section: { flex: 1, paddingTop: 10, paddingHorizontal: 14, paddingBottom: 11, gap: 3 },
  heading: { marginBottom: 3, fontSize: 11, fontWeight: '600', letterSpacing: 0.7, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  text: { fontSize: 14, lineHeight: 19 },
  label: { flexShrink: 1 },
  value: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  number: { fontWeight: '500', fontVariant: ['tabular-nums'] },
});
