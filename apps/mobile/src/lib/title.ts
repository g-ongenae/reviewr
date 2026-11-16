import { ApiError, titleToSend } from '@reviewr/shared';

/**
 * The title of an open document, saved on its own by a rename (no version), soon after the writer stops typing and
 * when the field loses focus. Framework-free: the editor shows `getSnapshot().value` and sends every keystroke to
 * `edit`.
 */
export interface TitleState {
  /** As typed: empty when the document is untitled. */
  value: string;
  /** `refused`: the server refused this title (a 4xx); it waits for a change or for the field to lose focus. */
  status: 'saved' | 'unsaved' | 'saving' | 'retrying' | 'refused';
  error?: unknown;
}

export interface TitleSaver {
  edit(value: string): void;
  /** The field lost focus: sends now. */
  blur(): void;
  /** A title read from the server: it replaces the field only when no edit is waiting. */
  refresh(title: string | null): void;
  getSnapshot(): TitleState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface TitleOptions {
  initial: string | null;
  rename: (title: string | null) => Promise<unknown>;
  debounceMs?: number;
  retryMs?: number;
}

export const createTitleSaver = ({ initial, rename, debounceMs = 800, retryMs = 5000 }: TitleOptions): TitleSaver => {
  let value = initial ?? '';
  /** Every edit is numbered; the field is saved once a rename sent at its latest edit is confirmed. */
  let edits = 0;
  let saved = 0;
  let inFlight = false;
  let error: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();

  const compute = (): TitleState => {
    if (saved >= edits) return { value, status: 'saved' };
    if (inFlight) return { value, status: 'saving' };
    if (error !== undefined) return { value, status: refused(error) ? 'refused' : 'retrying', error };
    return { value, status: 'unsaved' };
  };
  let snapshot = compute();
  const update = () => {
    snapshot = compute();
    for (const listener of [...listeners]) listener();
  };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(send, ms);
  };

  function send() {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || inFlight || saved >= edits) return;
    const edit = edits;
    inFlight = true;
    update();
    rename(titleToSend(value) ?? null).then(
      () => {
        inFlight = false;
        saved = Math.max(saved, edit);
        error = undefined;
        if (!disposed && saved < edits) schedule(debounceMs);
        update();
      },
      (failure: unknown) => {
        inFlight = false;
        // A title changed meanwhile is sent soon; a refused one waits for a change; a failed one is sent again later.
        if (edit < edits) {
          if (!disposed) schedule(debounceMs);
        } else {
          error = failure;
          if (!disposed && !refused(failure)) schedule(retryMs);
        }
        update();
      },
    );
  }

  return {
    edit(next) {
      if (disposed || next === value) return;
      value = next;
      edits++;
      error = undefined;
      schedule(debounceMs);
      update();
    },
    blur: () => send(),
    refresh(title) {
      if (disposed || saved < edits || inFlight || (title ?? '') === value) return;
      value = title ?? '';
      update();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
};

/** Whether the server refused a rename (a 4xx): sending the same title again cannot help, a changed one may. */
const refused = (error: unknown): boolean => error instanceof ApiError && error.status < 500;
