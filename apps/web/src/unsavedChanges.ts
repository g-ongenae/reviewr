/**
 * Tracks whether the open editor holds unsaved changes, so navigation can ask before discarding them.
 */
let dirty = false;

export const setUnsavedChanges = (value: boolean): void => {
  dirty = value;
};

/** Whether the open editor or composer holds unsaved changes. */
export const hasUnsavedChanges = (): boolean => dirty;

export const confirmDiscardChanges = (): boolean => !dirty || window.confirm('You have unsaved changes. Discard them?');
