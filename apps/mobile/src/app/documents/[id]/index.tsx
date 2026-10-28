import type { Document } from '@reviewr/shared';
import { contentMaxLength, titleMaxLength } from '@reviewr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, errorMessage, isConflict, queryKeys } from '@/lib/api';
import { countWords } from '@/lib/format';
import { useTheme } from '@/lib/theme';

export default function DocumentScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const document = useQuery({ queryKey: queryKeys.document(id), queryFn: () => api.getDocument(id) });

  if (document.isPending) {
    return <ActivityIndicator style={styles.message} color={theme.accent} />;
  }
  if (document.isError) {
    return <Text style={[styles.message, { color: theme.danger }]}>{errorMessage(document.error)}</Text>;
  }

  return <Editor document={document.data} />;
}

interface Draft {
  title: string;
  content: string;
}

const Editor = ({ document }: { document: Document }) => {
  const theme = useTheme();
  const queryClient = useQueryClient();
  // `base` is the server version the draft started from.
  const [base, setBase] = useState<Document>(document);
  const [draft, setDraft] = useState<Draft>({ title: document.title, content: document.content });
  const dirty = draft.title !== base.title || draft.content !== base.content;

  // The document changed on the server (e.g. a revision was restored from the history screen):
  // follow it, unless the user has local edits that would be lost.
  if (document.revision !== base.revision && !dirty) {
    setBase(document);
    setDraft({ title: document.title, content: document.content });
  }

  const onSaved = async (saved: Document) => {
    setBase(saved);
    queryClient.setQueryData(queryKeys.document(saved.id), saved);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.revisions(saved.id) }),
    ]);
  };

  const save = useMutation({
    mutationFn: (baseRevision: number) => api.updateDocument(document.id, { ...draft, baseRevision }),
    onSuccess: onSaved,
    onError: (error) => {
      if (!isConflict(error)) {
        Alert.alert('Could not save', errorMessage(error));
        return;
      }
      Alert.alert('Changed elsewhere', 'This document was saved from another device since you opened it.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard mine',
          style: 'destructive',
          onPress: () =>
            void api.getDocument(document.id).then(async (latest) => {
              setDraft({ title: latest.title, content: latest.content });
              await onSaved(latest);
            }),
        },
        {
          text: 'Keep mine',
          onPress: () => void api.getDocument(document.id).then((latest) => save.mutate(latest.revision)),
        },
      ]);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteDocument(document.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: queryKeys.document(document.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      router.back();
    },
    onError: (error) => Alert.alert('Could not delete', errorMessage(error)),
  });

  const confirmDelete = () =>
    Alert.alert('Delete document?', 'This also deletes its whole history.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
    ]);

  const status = save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : `Saved · revision ${base.revision}`;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                hitSlop={8}
                onPress={() => router.push({ pathname: '/documents/[id]/history', params: { id: document.id } })}
              >
                <Text style={[styles.headerButton, { color: theme.accent }]}>History</Text>
              </Pressable>
              <Pressable hitSlop={8} onPress={() => save.mutate(base.revision)} disabled={!dirty || save.isPending}>
                <Text style={[styles.headerButton, { color: dirty ? theme.accent : theme.muted }]}>Save</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={[styles.statusBar, { borderColor: theme.border }]}>
        <Text style={{ color: dirty ? theme.accent : theme.muted }}>{status}</Text>
        <Text style={{ color: theme.muted }}>{countWords(draft.content)} words</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TextInput
          style={[styles.titleInput, { color: theme.text }]}
          placeholder="Untitled"
          placeholderTextColor={theme.muted}
          value={draft.title}
          maxLength={titleMaxLength}
          onChangeText={(title) => setDraft({ ...draft, title })}
        />
        <TextInput
          style={[styles.contentInput, { color: theme.text }]}
          placeholder="Start writing…"
          placeholderTextColor={theme.muted}
          value={draft.content}
          maxLength={contentMaxLength}
          onChangeText={(content) => setDraft({ ...draft, content })}
          multiline
          scrollEnabled={false}
          textAlignVertical="top"
        />
        <Pressable onPress={confirmDelete} disabled={remove.isPending} style={styles.deleteButton}>
          <Text style={{ color: theme.danger }}>Delete document</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  message: { padding: 24, textAlign: 'center' },
  headerActions: { flexDirection: 'row', gap: 20 },
  headerButton: { fontSize: 16, fontWeight: '600' },
  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scroll: { padding: 16, flexGrow: 1 },
  titleInput: { fontSize: 26, fontWeight: '700', paddingVertical: 8 },
  contentInput: { flexGrow: 1, minHeight: 300, fontSize: 18, lineHeight: 28, fontFamily: 'serif' },
  deleteButton: { alignSelf: 'center', padding: 16, marginTop: 24 },
});
