import { displayTitle, formatBuildVersion, type Document } from '@reviewr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ToolbarButton } from '@/components/ToolbarButton';
import { api, apiUrl, inlineError, queryKeys } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { createNewDocument } from '@/lib/newDocument';
import { useTheme } from '@/lib/theme';

/** "New": an empty document with no version yet, whose creation is sent again on the same id if its answer is lost. */
const newDocument = createNewDocument({ api, newId: randomUUID });

export default function DocumentListScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const documents = useQuery({ queryKey: queryKeys.documents, queryFn: () => api.listDocuments() });

  const create = useMutation({
    mutationFn: newDocument,
    onSuccess: async (document) => {
      // A creation sent again answers a document that may be open already: what the app holds for it is never older.
      queryClient.setQueryData<Document>(queryKeys.document(document.id), (cached) => cached ?? document);
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      router.push({ pathname: '/documents/[id]', params: { id: document.id } });
    },
  });

  const createError = inlineError(create.error);
  // When the server is unreachable the notification says so: show the (empty) list, which can be pulled to retry.
  const listError = inlineError(documents.error);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <ToolbarButton
              label="New document"
              text="+ New"
              kind="primary"
              disabled={create.isPending}
              onPress={() => create.mutate()}
            />
          ),
        }}
      />
      {createError && <Text style={[styles.message, { color: theme.danger }]}>{createError}</Text>}
      {documents.isPending ? (
        <ActivityIndicator style={styles.message} color={theme.accent} />
      ) : listError !== undefined ? (
        <Text style={[styles.message, { color: theme.danger }]}>Could not load documents: {listError}</Text>
      ) : (
        <FlatList
          data={documents.data}
          keyExtractor={(document) => document.id}
          refreshing={documents.isRefetching}
          onRefresh={() => void documents.refetch()}
          ListEmptyComponent={
            <Text style={[styles.message, { color: theme.muted }]}>
              {documents.isError
                ? `Waiting for ${apiUrl}… Pull down to retry.`
                : 'No documents yet. Tap “New” to start writing.'}
            </Text>
          }
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.border }]} />}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.item, pressed && { backgroundColor: theme.surface }]}
              onPress={() => router.push({ pathname: '/documents/[id]', params: { id: item.id } })}
            >
              <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                {displayTitle(item)}
              </Text>
              <Text style={{ color: theme.muted }}>{formatDate(item.updatedAt)}</Text>
            </Pressable>
          )}
        />
      )}
      <Text style={[styles.version, { color: theme.muted, paddingBottom: insets.bottom + 8 }]}>
        {formatBuildVersion(process.env.EXPO_PUBLIC_BUILD_VERSION)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  message: { padding: 24, textAlign: 'center' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  item: { paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  title: { fontSize: 17, fontWeight: '500' },
  version: { paddingTop: 8, paddingHorizontal: 16, fontSize: 12, fontVariant: ['tabular-nums'], opacity: 0.8 },
});
