import type { AutosaveState } from '@reviewr/autosave';
import type { Stop } from '@reviewr/reconcile';
import type { Document } from '@reviewr/shared';
import { conflictOf, contentMaxLength, describeError, displayTitle, titleMaxLength } from '@reviewr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, inlineError, queryKeys } from '@/lib/api';
import { draftsOf, fetchDocument } from '@/lib/appDrafts';
import { heldTexts, shownDocument, textMoved } from '@/lib/drafts';
import { countWords } from '@/lib/format';
import type { TitleState } from '@/lib/title';
import { useTheme } from '@/lib/theme';

export default function DocumentScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const document = useQuery({ queryKey: queryKeys.document(id), queryFn: () => fetchDocument(queryClient, id) });

  // A read that fails (deleted elsewhere, server down) keeps showing a text the app holds for the document.
  const shown = shownDocument(draftsOf(queryClient), id, document.data);
  if (shown !== undefined) {
    return <Editor document={shown} />;
  }
  if (document.isPending) {
    return <ActivityIndicator style={styles.message} color={theme.accent} />;
  }
  const message = inlineError(document.error);
  return message === undefined ? (
    <Text style={[styles.message, { color: theme.muted }]}>This document will open as soon as the server is back.</Text>
  ) : (
    <Text style={[styles.message, { color: theme.danger }]}>{message}</Text>
  );
}

/** What the status line says about the text: whether it is on the server, and whether it differs from the last version. */
const textStatus = (state: AutosaveState, revision: number, changedSinceVersion: boolean): string => {
  switch (state.status) {
    case 'unsaved':
      return 'Unsaved changes';
    case 'saving':
      return 'Saving…';
    case 'retrying':
      return 'Not saved · retrying';
    case 'conflict':
      return 'Not saved · changed elsewhere';
    case 'rejected':
      return 'Not saved';
    case 'saved':
      if (revision === 0) return 'Draft saved · no version yet';
      return changedSinceVersion ? `Draft saved · changed since revision ${revision}` : `Saved · revision ${revision}`;
  }
};

const titleStatus = (state: TitleState): string => {
  switch (state.status) {
    case 'refused':
      return 'Title not saved';
    case 'retrying':
      return 'Title not saved · retrying';
    case 'saving':
      return 'Saving title…';
    default:
      return 'Unsaved changes';
  }
};

/** Why "Save version" created no version, when the draft itself was saved. */
const versionError = (error: unknown): string => {
  if (error === textMoved || conflictOf(error)?.code === 'draft_conflict') {
    return 'The version was not saved: the text changed while it was being saved. Your text is saved as a draft.';
  }
  const detail = inlineError(error);
  return `The version could not be saved${detail ? ` (${detail})` : ''}. Your text is saved as a draft: try again.`;
};

/** Why "Keep mine" did not save the text. */
const stopText = (stop: Stop): string => {
  switch (stop.reason) {
    case 'moved':
      return 'The other device changed the text again, so yours was not saved.';
    case 'failed': {
      const error = inlineError(stop.error);
      return `Your text could not be saved${error ? ` (${error})` : ''}.`;
    }
    case 'changed':
      return 'Your text changed meanwhile, so it was not saved.';
  }
};

const Editor = ({ document }: { document: Document }) => {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const drafts = draftsOf(queryClient);
  // The entry outlives the screen: what was typed just before leaving is still saved.
  const [{ autosave, session, title }] = useState(() => drafts.open(document));
  const state = useSyncExternalStore(autosave.subscribe, autosave.getSnapshot);
  const titleState = useSyncExternalStore(title.subscribe, title.getSnapshot);
  const sessionState = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => drafts.hold(document.id), [drafts, document.id]);
  // A newer draft read from the server goes to the machine, which never replaces unsaved text with it.
  useEffect(() => drafts.read(document), [drafts, document]);

  const { content } = state;
  const changedSinceVersion = content !== document.content;
  const busy = sessionState.running;
  /** The other device's text of a conflict and the texts "Keep mine" holds: none is in the text field. */
  const hidden = heldTexts({ session, autosave });

  const saveVersion = useMutation({ mutationFn: () => drafts.saveVersion(document.id, document.revision) });

  const remove = useMutation({
    mutationFn: () => api.deleteDocument(document.id),
    onSuccess: async () => {
      drafts.discard(document.id);
      queryClient.removeQueries({ queryKey: queryKeys.document(document.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      router.back();
    },
    onError: (error) => {
      const message = inlineError(error);
      if (message !== undefined) Alert.alert('Could not delete', message);
    },
  });

  const confirmDelete = () =>
    Alert.alert('Delete document?', 'This also deletes its whole history.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
    ]);

  const canSave =
    changedSinceVersion &&
    !saveVersion.isPending &&
    !busy &&
    state.status !== 'conflict' &&
    state.status !== 'rejected';
  const saved = state.status === 'saved' && titleState.status === 'saved' && !saveVersion.isPending;
  const status = saveVersion.isPending
    ? 'Saving version…'
    : state.status !== 'saved' || titleState.status === 'saved'
      ? textStatus(state, document.revision, changedSinceVersion)
      : titleStatus(titleState);

  /** What the notice above the text says, and whether it offers "Keep mine". */
  let notice: { text: string; error?: boolean; keepMine?: boolean } | undefined;
  if (state.status === 'rejected') {
    notice = state.permanent
      ? {
          text: 'This document was deleted elsewhere: your text is no longer saved. Copy it before leaving.',
          error: true,
        }
      : { text: `The server refused this text (${describeError(state.error)}). Change it to save again.`, error: true };
  } else if (state.status === 'conflict') {
    const { stop } = sessionState;
    notice = busy
      ? { text: 'Keeping the other device’s text as a version, then saving yours…' }
      : stop !== undefined
        ? { text: `${stopText(stop)} Your text is still here.`, error: stop.reason === 'failed', keepMine: true }
        : {
            text: 'This text was also changed on another device. “Keep mine” keeps the other text as a version in the history, then saves yours.',
            keepMine: true,
          };
  } else if (saveVersion.isError) {
    notice = { text: versionError(saveVersion.error), error: true };
  }

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
              <Pressable hitSlop={8} onPress={() => saveVersion.mutate()} disabled={!canSave}>
                <Text style={[styles.headerButton, { color: canSave ? theme.accent : theme.muted }]}>Save version</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={[styles.statusBar, { borderColor: theme.border }]}>
        <Text style={{ color: saved ? theme.muted : theme.accent }}>{status}</Text>
        <Text style={{ color: theme.muted }}>{countWords(content)} words</Text>
      </View>
      {notice !== undefined && (
        <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: theme.warning }]}>
          <Text style={{ color: notice.error === true ? theme.danger : theme.text }}>{notice.text}</Text>
          {notice.keepMine === true && (
            <Pressable
              style={[styles.noticeButton, { backgroundColor: theme.accent }]}
              onPress={() => void drafts.keepMine(document.id)}
            >
              <Text style={styles.noticeButtonLabel}>Keep mine</Text>
            </Pressable>
          )}
        </View>
      )}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {hidden.map(({ text, side, discardable }) => (
          <View key={text} style={[styles.held, { borderColor: theme.border }]}>
            <Text style={{ color: theme.muted }}>
              {side === 'mine'
                ? 'An earlier text of yours, in no version yet. “Keep mine” keeps it as a version.'
                : 'The other device’s text. “Keep mine” keeps it as a version, then saves yours.'}
              {discardable && ' Copy what you need if you discard it.'}
            </Text>
            <Text selectable style={{ color: theme.text }}>
              {text}
            </Text>
            {discardable && (
              <Pressable hitSlop={8} onPress={() => session.discardText(text)}>
                <Text style={{ color: theme.danger }}>Discard</Text>
              </Pressable>
            )}
          </View>
        ))}
        <TextInput
          style={[styles.titleInput, { color: theme.text }]}
          placeholder={displayTitle({ title: undefined, createdAt: document.createdAt })}
          placeholderTextColor={theme.muted}
          value={titleState.value}
          maxLength={titleMaxLength}
          onChangeText={title.edit}
          onBlur={title.blur}
        />
        <TextInput
          style={[styles.contentInput, { color: theme.text }]}
          placeholder="Start writing…"
          placeholderTextColor={theme.muted}
          value={content}
          maxLength={contentMaxLength}
          // Read-only while "Keep mine" runs: it saves the text it was given.
          editable={!busy}
          onChangeText={autosave.edit}
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
  notice: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  noticeButton: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  noticeButtonLabel: { color: '#fff', fontWeight: '600' },
  scroll: { padding: 16, flexGrow: 1 },
  held: { gap: 8, padding: 12, marginBottom: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  titleInput: { fontSize: 26, fontWeight: '700', paddingVertical: 8 },
  contentInput: { flexGrow: 1, minHeight: 300, fontSize: 18, lineHeight: 28, fontFamily: 'serif' },
  deleteButton: { alignSelf: 'center', padding: 16, marginTop: 24 },
});
