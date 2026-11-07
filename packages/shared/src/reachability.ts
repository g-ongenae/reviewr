import { ApiError } from './api-error.js';
import { isServerUnreachable } from './errors.js';

/**
 * Remembers whether the API was reachable on the last request, so apps can show a single "Server unreachable" notice
 * however many requests fail. Shaped for React's `useSyncExternalStore`.
 */
export class ReachabilityTracker {
  private unreachable: boolean = false;
  private readonly listeners: Set<() => void> = new Set();

  /**
   * Whether the last request that settled could not reach the API.
   */
  public readonly isUnreachable = (): boolean => this.unreachable;

  /**
   * Listen to changes; returns the function that stops listening.
   */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Record a failed request. Errors the API answered itself (4xx, 500) still prove it is reachable.
   */
  public reportError(error: unknown): void {
    if (isServerUnreachable(error)) {
      this.set(true);
    } else if (error instanceof ApiError) {
      this.set(false);
    }
  }

  /**
   * Record a successful request.
   */
  public reportSuccess(): void {
    this.set(false);
  }

  /**
   * Update the state and notify listeners if it changed.
   */
  private set(unreachable: boolean): void {
    if (unreachable === this.unreachable) {
      return;
    }
    this.unreachable = unreachable;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
