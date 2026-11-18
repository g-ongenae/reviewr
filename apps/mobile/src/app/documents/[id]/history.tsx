import { displayTitle } from '@reviewr/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ToolbarButton } from '@/components/ToolbarButton';
import { api, inlineError, queryKeys } from '@/lib/api';
import { draftsOf, fetchDocument } from '@/lib/appDrafts';
import { textMoved } from '@/lib/drafts';
import { formatDate } from '@/lib/format';
import { useTheme } from '@/lib/theme';

export default function HistoryScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [selected, setSelected] = useState<number | undefined>(undefined);

  const revisions = useQuery({ queryKey: queryKeys.revisions(id), queryFn: () => api.listRevisions(id) });
  // Already cached by the document screen; an untitled revision is named after the document's creation day.
  const document = useQuery({ queryKey: queryKeys.document(id), queryFn: () => fetchDocument(queryClient, id) });
  const preview = useQuery({
    queryKey: queryKeys.revision(id, selected ?? 0),
    queryFn: () => api.getRevision(id, selected ?? 0),
    enabled: selected !== undefined,
    staleTime: Infinity, // Revisions are immutable.
  });
  const currentRevision = revisions.data?.[0]?.revision;

  // Restoring puts the old version in the editor as an edit: the autosave sends it as the draft. The text it replaces
  // is kept as a version first, unless it is the head's. Never while a conflict or a deletion holds the text.
  const [restoring, setRestoring] = useState(false);
  const restore = async () => {
    if (preview.data === undefined || document.data === undefined) return;
    const drafts = draftsOf(queryClient);
    // Opened without an editor (a link): the restore goes to an entry opened here, then to its editor.
    const editorShown = (drafts.get(id)?.users ?? 0) > 0;
    drafts.open(document.data);
    setRestoring(true);
    const outcome = await drafts.restore(id, preview.data, document.data);
    setRestoring(false);
    if (outcome.kind === 'restored') {
      if (editorShown) router.back();
      else router.replace({ pathname: '/documents/[id]', params: { id } });
    } else if (outcome.kind === 'refused') {
      Alert.alert(
        'Not restored',
        'This document was changed on another device, or deleted: your text in the editor is kept as it is. Resolve that first.',
      );
    } else if (outcome.error === textMoved) {
      Alert.alert(
        'Not restored',
        'The text in the editor changed during the restore, so nothing was restored. Your text is kept as it is.',
      );
    } else {
      const detail = inlineError(outcome.error) ?? 'the server is unreachable';
      Alert.alert(
        'Not restored',
        `Your current text could not be kept as a version first (${detail}), so nothing was restored. Your text is still in the editor.`,
      );
    }
  };

  if (revisions.isPending) {
    return <ActivityIndicator style={styles.message} color={theme.accent} />;
  }
  if (revisions.isError) {
    const message = inlineError(revisions.error);
    return (
      <Text style={[styles.message, { color: message === undefined ? theme.muted : theme.danger }]}>
        {message ?? 'The history will show up as soon as the server is back.'}
      </Text>
    );
  }

  return (
    <FlatList
      data={revisions.data}
      keyExtractor={(revision) => String(revision.revision)}
      ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.border }]} />}
      renderItem={({ item }) => {
        const isSelected = item.revision === selected;
        return (
          <View>
            <Pressable
              style={[styles.item, isSelected && { backgroundColor: theme.surface }]}
              onPress={() => setSelected(isSelected ? undefined : item.revision)}
            >
              <Text style={[styles.title, { color: theme.text }]}>
                Revision {item.revision}
                {item.revision === currentRevision ? ' · current' : ''}
              </Text>
              <Text style={{ color: theme.muted }}>
                {displayTitle({ title: item.title, createdAt: document.data?.createdAt ?? item.createdAt })} ·{' '}
                {formatDate(item.createdAt)}
              </Text>
            </Pressable>
            {isSelected && (
              <View style={[styles.preview, { backgroundColor: theme.surface }]}>
                {preview.isPending ? (
                  <ActivityIndicator color={theme.accent} />
                ) : preview.isError ? (
                  <Text style={{ color: theme.danger }}>{inlineError(preview.error)}</Text>
                ) : (
                  <>
                    <Text style={[styles.previewText, { color: theme.text }]}>{preview.data.content}</Text>
                    {item.revision !== currentRevision && (
                      <View style={styles.restore}>
                        <ToolbarButton
                          label={restoring ? 'Restoring…' : 'Restore into editor'}
                          text={restoring ? 'Restoring…' : 'Restore into editor'}
                          kind="primary"
                          disabled={restoring}
                          onPress={() => void restore()}
                        />
                      </View>
                    )}
                  </>
                )}
              </View>
            )}
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  message: { padding: 24, textAlign: 'center' },
  separator: { height: StyleSheet.hairlineWidth },
  item: { paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  title: { fontSize: 17, fontWeight: '500' },
  preview: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  previewText: { fontSize: 16, lineHeight: 24, fontFamily: 'serif' },
  restore: { alignSelf: 'flex-start' },
});
