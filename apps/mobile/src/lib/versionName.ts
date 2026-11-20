import { revisionNameMaxLength } from '@reviewr/shared';

/** The name field of "Save version", under the editor's status line. */
export interface VersionNameState {
  /** Whether the field is shown. */
  open: boolean;
  /** As typed. */
  value: string;
  /** A version is being saved with this name: the field waits for the answer. */
  saving: boolean;
  /** The save returned a version, but its name could not be confirmed. */
  unconfirmed?: boolean;
}

export interface VersionName {
  getSnapshot(): VersionNameState;
  subscribe(listener: () => void): () => void;
  /** Shows the field, empty, or hides it and forgets what was typed. Nothing changes while a version is saved. */
  toggle(): void;
  edit(value: string): void;
  /**
   * Saves a version through `saveVersion`, with the name typed when the field is shown. A version with the requested name closes the
   * field and empties it, so that its name is not the next version's; anything else (an error, or no version made
   * because the draft could not be saved) leaves the name as typed, to save again with one tap.
   */
  save<T>(
    saveVersion: (name?: string) => Promise<T | undefined>,
    readName: (saved: T) => Promise<string | null | undefined>,
  ): Promise<T | undefined>;
}

/** The name a version is saved with: trimmed and cut at the server's limit; a blank name is no name. */
export const versionNameToSend = (value: string): string | undefined => {
  const trimmed = value.trim().slice(0, revisionNameMaxLength);
  return trimmed === '' ? undefined : trimmed;
};

const closed: VersionNameState = { open: false, value: '', saving: false };

export const createVersionName = (): VersionName => {
  let state = closed;
  const listeners = new Set<() => void>();
  const set = (next: VersionNameState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle() {
      if (!state.saving) set(state.open ? closed : { ...closed, open: true });
    },
    edit(value) {
      if (state.open && !state.saving) set({ ...state, value });
    },
    async save(saveVersion, readName) {
      const name = state.open ? versionNameToSend(state.value) : undefined;
      const before = state;
      set({ ...state, saving: true, unconfirmed: undefined });
      try {
        const saved = await saveVersion(name);
        if (saved === undefined) {
          set(before);
        } else if (name !== undefined && (await readName(saved).catch(() => undefined)) !== name) {
          set({ ...before, unconfirmed: true });
        } else {
          set(closed);
        }
        return saved;
      } catch (error) {
        set(before);
        throw error;
      }
    },
  };
};
