import type { SQLiteDatabase } from 'expo-sqlite';
import { openLocalBuffer, type LocalBuffer, type SqlDatabase } from './localBuffer';

/** `expo-sqlite`'s connection, seen through the buffer's narrow interface. */
export const expoSqlDatabase = (db: SQLiteDatabase): SqlDatabase => ({
  exec: (sql) => db.execAsync(sql),
  run: async (sql, params) => {
    const { changes } = await db.runAsync(sql, [...params]);
    return { changes };
  },
  all: (sql, params) => db.getAllAsync<unknown>(sql, [...params]),
  close: () => db.closeAsync(),
});

let buffer: LocalBuffer | undefined;

/**
 * The phone's local buffer, in the app's SQLite database `reviewr-buffer.db`: one buffer on one connection (its own,
 * not one shared through `expo-sqlite`'s cache) for the life of the process. Every call answers the same buffer; it
 * is never replaced, so no second writer can ever reach the database.
 *
 * `expo-sqlite` is loaded when the buffer first opens, not when this file is imported: a binary built without its
 * native module then answers `unavailable` instead of throwing.
 */
export const deviceLocalBuffer = (): LocalBuffer =>
  (buffer ??= openLocalBuffer({
    open: async () => {
      const { openDatabaseAsync } = await import('expo-sqlite');
      return expoSqlDatabase(await openDatabaseAsync('reviewr-buffer.db', { useNewConnection: true }));
    },
  }));
