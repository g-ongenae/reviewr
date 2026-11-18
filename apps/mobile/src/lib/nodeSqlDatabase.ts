/// <reference types="node" />
/**
 * Node's built-in SQLite (`node:sqlite`, Node 22.13+) behind the local buffer's `SqlDatabase`, so that its tests run
 * the same SQL as the phone. Test-only: the app uses `deviceLocalBuffer.ts`.
 *
 * Only `import type` from the app's code: a child process loads this file with Node's type stripping, without a
 * bundler.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlValue } from './localBuffer';

export interface NodeSqlOptions {
  /** Waits this long (milliseconds) before each statement, so that calls overlap as they do on a phone. */
  delay?: () => number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const nodeSqlDatabase = (path: string, options: NodeSqlOptions = {}): SqlDatabase & { raw: DatabaseSync } => {
  const raw = new DatabaseSync(path);
  const step = async <T>(body: () => T): Promise<T> => {
    const ms = options.delay?.() ?? 0;
    if (ms > 0) await wait(ms);
    return body();
  };
  return {
    raw,
    exec: (sql) => step(() => raw.exec(sql)),
    run: (sql, params) =>
      step(() => {
        const { changes } = raw.prepare(sql).run(...(params as SqlValue[]));
        return { changes: Number(changes) };
      }),
    all: (sql, params) => step(() => raw.prepare(sql).all(...(params as SqlValue[])) as unknown[]),
    close: () => step(() => raw.close()),
  };
};
