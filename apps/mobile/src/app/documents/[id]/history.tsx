import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, errorMessage, queryKeys } from '@/lib/api';
import { displayTitle, formatDate } from '@/lib/format';
import { useTheme } from '@/lib/theme';

export default function HistoryScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [selected, setSelected] = useState<number | undefined>(undefined);

  const revisions = useQuery({ queryKey: queryKeys.revisions(id), queryFn: () => api.listRevisions(id) });
  const preview = useQuery({
    queryKey: queryKeys.revision(id, selected ?? 0),
    queryFn: () => api.getRevision(id, selected ?? 0),
    enabled: selected !== undefined,
    staleTime: Infinity, // Revisions are immutable.
  });
  const currentRevision = revisions.data?.[0]?.revision;

  // Restoring saves the old version as a new revision, so the history is never rewritten.
  const restore = useMutation({
    mutationFn: async () => {
      if (preview.data === undefined || currentRevision === undefined) {
        throw new Error('Nothing to restore');
      }
      return api.updateDocument(id, {
        title: preview.data.title,
        content: preview.data.content,
        baseRevision: currentRevision,
      });
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(queryKeys.document(id), saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.revisions(id) }),
      ]);
      router.back();
    },
    onError: (error) => Alert.alert('Could not restore', errorMessage(error)),
  });

  if (revisions.isPending) {
    return <ActivityIndicator style={styles.message} color={theme.accent} />;
  }
  if (revisions.isError) {
    return <Text style={[styles.message, { color: theme.danger }]}>{errorMessage(revisions.error)}</Text>;
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
                {displayTitle(item.title)} · {formatDate(item.createdAt)}
              </Text>
            </Pressable>
            {isSelected && (
              <View style={[styles.preview, { backgroundColor: theme.surface }]}>
                {preview.isPending ? (
                  <ActivityIndicator color={theme.accent} />
                ) : preview.isError ? (
                  <Text style={{ color: theme.danger }}>{errorMessage(preview.error)}</Text>
                ) : (
                  <>
                    <Text style={[styles.previewText, { color: theme.text }]}>{preview.data.content}</Text>
                    {item.revision !== currentRevision && (
                      <Pressable
                        style={[styles.restoreButton, { backgroundColor: theme.accent }]}
                        disabled={restore.isPending}
                        onPress={() => restore.mutate()}
                      >
                        <Text style={styles.restoreLabel}>Restore this version</Text>
                      </Pressable>
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
  restoreButton: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  restoreLabel: { color: '#fff', fontWeight: '600' },
});
