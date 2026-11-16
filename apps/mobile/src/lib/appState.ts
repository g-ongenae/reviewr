import { focusManager } from '@tanstack/react-query';
import type { Drafts } from './drafts';

/**
 * What the app does when React Native's `AppState` changes (the app has no web build, where the browser's own focus
 * events would apply). Becoming active is TanStack Query's focus: the documents shown are read again. Leaving saves
 * every document at once, since the system may stop the app there.
 */
export const onAppStateChange =
  (drafts: Drafts) =>
  (state: string): void => {
    focusManager.setFocused(state === 'active');
    if (state !== 'active') drafts.flushAll();
  };
