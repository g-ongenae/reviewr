/**
 * Which of the writing stats' reads may run: none while the panel is hidden, or while the stored choice is not read
 * yet (the panel is not drawn then). Shown, "today" reads the history only when it needs it, then the last revision
 * saved before today once known; "last revision" reads the revision before the saved one, if there is one.
 */
export const baselineReads = (
  shown: boolean | undefined,
  needs: { history: boolean; lastBeforeToday: number | undefined; previous: number },
): { revisions: boolean; todayRevision: boolean; previousRevision: boolean } => {
  const active = shown === true;

  return {
    revisions: active && needs.history,
    todayRevision: active && needs.history && needs.lastBeforeToday !== undefined,
    previousRevision: active && needs.previous > 0,
  };
};
