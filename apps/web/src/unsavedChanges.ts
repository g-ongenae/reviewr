/**
 * Tracks whether the open editor holds unsaved changes, so navigation can ask before discarding them.
 */
let dirty = false;

export const setUnsavedChanges = (value: boolean): void => {
  dirty = value;
};

export const confirmDiscardChanges = (): boolean => !dirty || window.confirm('You have unsaved changes. Discard them?');
