import type { Document } from '@reviewr/shared';
import { contentMaxLength } from '@reviewr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useEffectEvent, useState } from 'react';
import { api, errorMessage, queryKeys } from '../api';
import { countWords } from '../format';
import { setUnsavedChanges } from '../unsavedChanges';

interface Props {
  /** Called once the text has been saved as a new document. */
  onCreated: (document: Document) => void;
  toolbarStart?: ReactNode;
}

/**
 * Home page: a blank page ready to type in. The text only becomes a document when it is saved.
 */
export const Composer = ({ onCreated, toolbarStart }: Props) => {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const dirty = content.trim().length > 0;

  const create = useMutation({
    mutationFn: () => api.createDocument({ title: '', content }),
    onSuccess: async (document) => {
      setUnsavedChanges(false);
      queryClient.setQueryData(queryKeys.document(document.id), document);
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents, exact: true });
      onCreated(document);
    },
  });

  const saveNow = useEffectEvent(() => {
    if (dirty && !create.isPending) {
      create.mutate();
    }
  });

  // Ctrl/Cmd + S saves.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveNow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Warn before leaving the page or opening a document with unsaved text.
  useEffect(() => {
    setUnsavedChanges(dirty);
    if (!dirty) {
      return undefined;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  useEffect(() => () => setUnsavedChanges(false), []);

  return (
    <section className="editor">
      <div className="toolbar">
        {toolbarStart}
        {dirty && (
          <>
            <span className="status dirty">{create.isPending ? 'Saving…' : 'Unsaved changes'}</span>
            <span className="muted small">{countWords(content)} words</span>
          </>
        )}
        <span className="spacer" />
        <button
          className="primary"
          disabled={!dirty || create.isPending}
          onClick={() => create.mutate()}
          title="Ctrl+S"
        >
          Save
        </button>
      </div>

      {create.isError && <div className="banner error">{errorMessage(create.error)}</div>}

      <div className="composer">
        <textarea
          className="content-input"
          aria-label="New document"
          value={content}
          maxLength={contentMaxLength}
          onChange={(event) => setContent(event.target.value)}
          autoFocus
        />
        {content.length === 0 && (
          <div className="composer-placeholder" aria-hidden="true">
            <h1>What do you want to tell today?</h1>
            <p>Or start reviewing an existing text from the sidebar.</p>
          </div>
        )}
      </div>
    </section>
  );
};
