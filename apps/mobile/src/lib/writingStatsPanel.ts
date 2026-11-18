import { useSyncExternalStore } from 'react';
import { storedBoolean } from './storedBoolean';

/**
 * Whether the writing stats panel is shown: shown by default, remembered across restarts and shared by every
 * document, as on the web. Kept in `reviewr-preferences.db`, a database of its own, never the local buffer's. Read as
 * the app starts, so the editor rarely opens before the stored choice is known; `expo-sqlite` is loaded then, not
 * when this file is imported.
 */
const panel = storedBoolean(
  async () => {
    const { SQLiteStorage } = await import('expo-sqlite/kv-store');
    return new SQLiteStorage('reviewr-preferences.db');
  },
  'reviewr.writingStatsOpen',
  true,
);

/**
 * Whether the panel is shown, or undefined while the stored choice is read: then the panel is not drawn (it never
 * appears and disappears again) and the toggle offers to show it, which a tap does.
 */
export const useWritingStatsPanel = (): [open: boolean | undefined, toggle: () => void] => [
  useSyncExternalStore(panel.subscribe, panel.get),
  () => panel.set(!(panel.get() ?? false)),
];
