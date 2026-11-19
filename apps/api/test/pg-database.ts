import pg from 'pg';
import { runMigrations } from '../src/database/migrate.js';

/**
 * A database of its own on a real PostgreSQL, for the `*.pg.spec.ts` files (the e2e tests run on PGlite, which runs
 * one transaction at a time).
 *
 * `TEST_DATABASE_URL` points at a server where the user may create databases; each file creates its own database,
 * migrates it and drops it at the end. Without the variable the files are skipped, unless `REQUIRE_TEST_DATABASE` is
 * set (the CI), where a missing variable is an error.
 */
export const serverUrl: string | undefined = process.env.TEST_DATABASE_URL;
if (serverUrl === undefined && process.env.REQUIRE_TEST_DATABASE !== undefined) {
  throw new Error('REQUIRE_TEST_DATABASE is set but TEST_DATABASE_URL is not: the PostgreSQL tests would be skipped');
}

/** Creating and migrating the database, or waiting for its sessions to close, on a loaded machine with a slow disk. */
export const setupTimeout: number = 120_000;

/** A migrated test database: a pool of 10 connections on it, and an admin connection to the server. */
export interface TestDatabase {
  name: string;
  admin: pg.Client;
  pool: pg.Pool;
}

/**
 * Close the pool and drop the database.
 *
 * `pool.end()` resolves before the server has closed every session. Dropping the database by force at that moment
 * terminates them, and the clients, already detached from the pool, report it as unhandled errors that fail the run.
 * So wait until the sessions are gone, then drop without force: if one is still there after 10 s, the drop fails and
 * names the database, which is left for a manual cleanup.
 */
export const closeTestDatabase = async ({
  name,
  admin,
  pool,
}: Omit<TestDatabase, 'pool'> & { pool: pg.Pool | undefined }): Promise<void> => {
  await pool?.end();
  for (let attempt: number = 0; attempt < 400; attempt += 1) {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    if (rows[0]?.n === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
};

/**
 * Create and migrate a database named `<prefix>_<pid>_<time>`. If a step fails after the database was created, the
 * database is dropped and the admin connection closed before the error is thrown: the caller gets nothing to clean.
 */
export const openTestDatabase = async (prefix: string): Promise<TestDatabase> => {
  const name: string = `${prefix}_${process.pid}_${Date.now()}`;
  const admin: pg.Client = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const url: URL = new URL(serverUrl ?? '');
  url.pathname = `/${name}`;
  try {
    await runMigrations(url.toString());
  } catch (error) {
    // `runMigrations` ends its own pool; the drop waits for its sessions like `closeTestDatabase`.
    await closeTestDatabase({ name, admin, pool: undefined });
    throw error;
  }

  return { name, admin, pool: new pg.Pool({ connectionString: url.toString(), max: 10 }) };
};
