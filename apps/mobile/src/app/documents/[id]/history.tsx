import { displayTitle, type RevisionSummary } from '@reviewr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ToolbarButton } from '@/components/ToolbarButton';
import { VersionNameInput } from '@/components/VersionNameInput';
import { api, inlineError, queryKeys } from '@/lib/api';
import { draftsOf, fetchDocument } from '@/lib/appDrafts';
import { textMoved } from '@/lib/drafts';
import { formatDate } from '@/lib/format';
import { nameRevisionKey, renameError, renameRevision, revisionLabel } from '@/lib/revisionName';
import { useTheme } from '@/lib/theme';

export default function HistoryScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [editing, setEditing] = useState<{ revision: RevisionSummary; value: string }>();
  const rename = useMutation({
    mutationKey: editing === undefined ? undefined : nameRevisionKey(editing.revision),
    networkMode: 'always',
    retry: false,
    mutationFn: ({ revision, value }: NonNullable<typeof editing>) => renameRevision(queryClient, api, revision, value),
    onSuccess: () => setEditing(undefined),
  });
  const startRename = (revision: RevisionSummary) => {
    if (queryClient.isMutating({ mutationKey: nameRevisionKey(revision) }) > 0) return;
    rename.reset();
    setEditing({ revision, value: revision.name ?? '' });
  };
  const submitRename = () => {
    if (editing === undefined) return;
    const mutationKey = nameRevisionKey(editing.revision);
    if (queryClient.isMutating({ mutationKey }) > 0) return;
    rename.mutate(editing);
  };

  const revisions = useQuery({ queryKey: queryKeys.revisions(id), queryFn: () => api.listRevisions(id) });
  // Already cached by the document screen; an untitled revision is named after the document's creation day.
  const document = useQuery({ queryKey: queryKeys.document(id), queryFn: () => fetchDocument(queryClient, id) });
  const preview = useQuery({
    queryKey: queryKeys.revision(id, selected ?? 0),
    queryFn: () => api.getRevision(id, selected ?? 0),
    enabled: selected !== undefined,
    staleTime: Infinity, // Revision text is immutable. Renaming refreshes the cached metadata.
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
  if (revisions.isError && revisions.data === undefined) {
    const message = inlineError(revisions.error);
    return (
      <Text style={[styles.message, { color: message === undefined ? theme.muted : theme.danger }]}>
        {message ?? 'The history will show up as soon as the server is back.'}
      </Text>
    );
  }

  return (
    <View style={styles.container}>
      {editing !== undefined && (
        <View style={[styles.rename, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>Name revision {editing.revision.revision}</Text>
          <VersionNameInput
            value={editing.value}
            onChangeText={(value) => setEditing({ ...editing, value })}
            placeholder="Leave blank to clear the name"
            editable={!rename.isPending}
            onSubmitEditing={submitRename}
          />
          {rename.isError && (
            <Text accessibilityRole="alert" style={{ color: theme.danger }}>
              {renameError(rename.error)}
            </Text>
          )}
          <View style={styles.renameActions}>
            <ToolbarButton
              label="Cancel"
              text="Cancel"
              disabled={rename.isPending}
              onPress={() => setEditing(undefined)}
            />
            <ToolbarButton
              label="Save name"
              text={rename.isPending ? 'Saving…' : 'Save name'}
              kind="primary"
              disabled={rename.isPending}
              onPress={submitRename}
            />
          </View>
        </View>
      )}
      <FlatList
        keyboardShouldPersistTaps="handled"
        data={revisions.data}
        keyExtractor={(revision) => String(revision.revision)}
        ListEmptyComponent={
          <Text style={[styles.message, { color: theme.muted }]}>
            No version yet. Your text is saved as a draft; “Save version” in the editor keeps it as the first version.
          </Text>
        }
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.border }]} />}
        renderItem={({ item }) => {
          const isSelected = item.revision === selected;
          const { heading, number } = revisionLabel(item);
          return (
            <View>
              <Pressable
                style={[styles.item, isSelected && { backgroundColor: theme.surface }]}
                onPress={() => setSelected(isSelected ? undefined : item.revision)}
              >
                <Text style={[styles.title, { color: theme.text }]}>
                  {heading}
                  {number === undefined && item.revision === currentRevision ? ' · current' : ''}
                </Text>
                <Text style={{ color: theme.muted }}>
                  {number === undefined ? '' : `${number}${item.revision === currentRevision ? ' · current' : ''} · `}
                  {displayTitle({ title: item.title, createdAt: document.data?.createdAt ?? item.createdAt })} ·{' '}
                  {formatDate(item.createdAt)}
                </Text>
              </Pressable>
              {isSelected && (
                <View style={[styles.preview, { backgroundColor: theme.surface }]}>
                  <View style={styles.restore}>
                    <ToolbarButton
                      label={item.name === null ? 'Name version' : 'Edit name'}
                      text={item.name === null ? 'Name version' : 'Edit name'}
                      disabled={editing !== undefined}
                      onPress={() => startRename(item)}
                    />
                  </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  rename: { gap: 8, padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  message: { padding: 24, textAlign: 'center' },
  separator: { height: StyleSheet.hairlineWidth },
  item: { paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  title: { fontSize: 17, fontWeight: '500' },
  preview: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  previewText: { fontSize: 16, lineHeight: 24, fontFamily: 'serif' },
  restore: { alignSelf: 'flex-start' },
});
