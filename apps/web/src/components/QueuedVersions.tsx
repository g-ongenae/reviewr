import { useCallback, useSyncExternalStore } from 'react';
import type { HoldReason, QueuedVersion, VersionQueue, VersionQueueState } from '../autosave/versionQueue';
import { HeldText } from './TextRecovery';

/** The versions of a document waiting for the server, and those held for the writer. */
export const useVersionQueue = (queue: VersionQueue): VersionQueueState =>
  useSyncExternalStore(
    useCallback((listener: () => void) => queue.subscribe(listener), [queue]),
    useCallback(() => queue.getSnapshot(), [queue]),
  );

/** What the toolbar says while versions are being created, or wait for the server (`waiting`). */
export const queuedStatus = (pending: readonly QueuedVersion[], waiting: boolean): string => {
  const one = pending.length === 1;
  if (waiting) return one ? 'Version waiting for the server' : `${pending.length} versions waiting for the server`;
  return one ? 'Saving version…' : `Saving ${pending.length} versions…`;
};

/** How a version that was not created is labelled. */
export const heldVersionLabel = ({ name }: QueuedVersion): string =>
  name === undefined ? 'A version not saved' : `Version “${name}”, not saved`;

/** Why a version was not created, on its own entry. */
const reasonText: Record<HoldReason, string> = {
  conflict: 'The text was changed on another device before this version could be created.',
  refused: 'The server refused this text.',
  deleted: 'The document was deleted before this version could be created.',
  unsure:
    'The connection was lost while this version was being created, and the document changed since: it may already be in the history. Check there before saving it again.',
};

/**
 * The versions that will not be created: readable and copyable, each with why, until the writer discards them. Nothing
 * is written over the other device's text.
 */
export const HeldVersions = ({ queue }: { queue: VersionQueue }) => {
  const { held } = useVersionQueue(queue);
  if (held.length === 0) return null;
  return (
    <div className="held-texts">
      <p>
        {held.length === 1
          ? 'This version was not created. It is kept here: copy what you need, then discard it.'
          : 'These versions were not created. Each is kept here: copy what you need, then discard it.'}
      </p>
      {held.map((version) => {
        const label = heldVersionLabel(version);
        return (
          <HeldText key={version.text} label={label} text={version.text} note={reasonText[version.reason]}>
            <button type="button" aria-label={`Discard: ${label}`} onClick={() => queue.discard(version.text)}>
              Discard this version
            </button>
          </HeldText>
        );
      })}
    </div>
  );
};
