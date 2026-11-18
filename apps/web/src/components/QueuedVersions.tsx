import { useCallback, useSyncExternalStore } from 'react';
import type { HeldVersion, QueuedVersion, VersionQueue, VersionQueueState } from '../autosave/versionQueue';
import { HeldText } from './TextRecovery';

/** The versions of a document waiting for the server, and those held for the writer. */
export const useVersionQueue = (queue: VersionQueue): VersionQueueState =>
  useSyncExternalStore(
    useCallback((listener: () => void) => queue.subscribe(listener), [queue]),
    useCallback(() => queue.getSnapshot(), [queue]),
  );

/** What the toolbar says while versions wait for the server. */
export const queuedStatus = (pending: readonly QueuedVersion[]): string =>
  pending.length === 1 ? 'Version waiting for the server' : `${pending.length} versions waiting for the server`;

/** How a version that was not created is labelled. */
export const heldVersionLabel = ({ name }: QueuedVersion): string =>
  name === undefined ? 'A version not saved' : `Version “${name}”, not saved`;

const reasonText = (held: readonly HeldVersion[]): string => {
  const one = held.length === 1;
  if (held.every((version) => version.reason === 'refused')) {
    return one ? 'The server refused this version.' : 'The server refused these versions.';
  }
  if (held.some((version) => version.reason === 'conflict')) {
    return one
      ? 'This version was saved while the server was unreachable, and the text was changed on another device before it could be created.'
      : 'These versions were saved while the server was unreachable, and the text was changed on another device before they could be created.';
  }
  return one ? 'This version could not be created.' : 'These versions could not be created.';
};

/**
 * The versions saved while the server was unreachable that will not be created: readable and copyable, until the
 * writer discards them. Nothing is written over the other device's text.
 */
export const HeldVersions = ({ queue }: { queue: VersionQueue }) => {
  const { held } = useVersionQueue(queue);
  if (held.length === 0) return null;
  return (
    <div className="held-texts">
      <p>
        {reasonText(held)} {held.length === 1 ? 'It is' : 'They are'} kept here, in no version: copy what you need, then
        discard {held.length === 1 ? 'it' : 'them'}.
      </p>
      {held.map((version) => (
        <HeldText key={version.text} label={heldVersionLabel(version)} text={version.text}>
          <button type="button" onClick={() => queue.discard(version.text)}>
            Discard this version
          </button>
        </HeldText>
      ))}
    </div>
  );
};
