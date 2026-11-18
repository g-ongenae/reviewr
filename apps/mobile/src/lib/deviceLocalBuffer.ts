import type { SQLiteDatabase } from 'expo-sqlite';
import { openLocalBuffer, type LocalBuffer, type LocalBufferOptions, type SqlDatabase } from './localBuffer';

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

/** The last buffer opened on the device's database: the next one waits for it to be closed and drained. */
let current: LocalBuffer | undefined;

/**
 * The phone's local buffer, in the app's SQLite database `reviewr-buffer.db`, on its own connection (not one shared
 * through `expo-sqlite`'s cache), so that closing it never closes someone else's.
 *
 * Opening one closes the one opened before, and opens the database only once that one's work drained: a write it
 * started cannot land after a write of the new one. If it could not be drained, the new one answers `stalled` until
 * the app restarts.
 *
 * `expo-sqlite` is loaded when the buffer first opens, not when this file is imported: a binary built without its
 * native module then answers `unavailable` instead of throwing.
 */
export const openDeviceLocalBuffer = (options: Omit<LocalBufferOptions, 'open' | 'previous'> = {}): LocalBuffer => {
  const buffer = openLocalBuffer({
    ...options,
    previous: current?.close(),
    open: async () => {
      const { openDatabaseAsync } = await import('expo-sqlite');
      return expoSqlDatabase(await openDatabaseAsync('reviewr-buffer.db', { useNewConnection: true }));
    },
  });
  current = buffer;
  return buffer;
};
