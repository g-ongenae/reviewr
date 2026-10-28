import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, apiUrl, errorMessage, queryKeys } from '@/lib/api';
import { displayTitle, formatDate } from '@/lib/format';
import { useTheme } from '@/lib/theme';

export default function DocumentListScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const documents = useQuery({ queryKey: queryKeys.documents, queryFn: () => api.listDocuments() });

  const create = useMutation({
    mutationFn: () => api.createDocument({ title: '', content: '' }),
    onSuccess: async (document) => {
      queryClient.setQueryData(queryKeys.document(document.id), document);
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      router.push({ pathname: '/documents/[id]', params: { id: document.id } });
    },
  });

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => create.mutate()} disabled={create.isPending} hitSlop={12}>
              <Text style={[styles.headerButton, { color: theme.accent }]}>New</Text>
            </Pressable>
          ),
        }}
      />
      {create.isError && <Text style={[styles.message, { color: theme.danger }]}>{errorMessage(create.error)}</Text>}
      {documents.isPending ? (
        <ActivityIndicator style={styles.message} color={theme.accent} />
      ) : documents.isError ? (
        <Text style={[styles.message, { color: theme.danger }]}>
          Could not reach {apiUrl}: {errorMessage(documents.error)}
        </Text>
      ) : (
        <FlatList
          data={documents.data}
          keyExtractor={(document) => document.id}
          refreshing={documents.isRefetching}
          onRefresh={() => void documents.refetch()}
          ListEmptyComponent={
            <Text style={[styles.message, { color: theme.muted }]}>No documents yet. Tap “New” to start writing.</Text>
          }
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.border }]} />}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.item, pressed && { backgroundColor: theme.surface }]}
              onPress={() => router.push({ pathname: '/documents/[id]', params: { id: item.id } })}
            >
              <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                {displayTitle(item.title)}
              </Text>
              <Text style={{ color: theme.muted }}>{formatDate(item.updatedAt)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerButton: { fontSize: 16, fontWeight: '600' },
  message: { padding: 24, textAlign: 'center' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  item: { paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  title: { fontSize: 17, fontWeight: '500' },
});
