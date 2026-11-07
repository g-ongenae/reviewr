/**
 * Error thrown by the client when no HTTP response came back at all (offline, DNS failure, connection refused…).
 */
export class NetworkError extends Error {
  /**
   * @param cause - Error raised by `fetch`
   */
  constructor(cause: unknown) {
    super('Network request failed', { cause });
    this.name = 'NetworkError';
  }
}
