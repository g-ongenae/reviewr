/**
 * The host timers the machine falls back to when it is given none. They are not part of ECMAScript, so `lib: ES2023`
 * does not declare them, and the package declares no DOM or Node types; every runtime the machine targets has them
 * (browsers, Node, React Native's Hermes). Only the package's own compilation sees this file: it is not emitted.
 */
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
