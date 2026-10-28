import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { migrationsFolder } from './database.js';

/**
 * Apply pending migrations to the database at `databaseUrl`.
 */
export const runMigrations = async (databaseUrl: string): Promise<void> => {
  const pool: pg.Pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
};

// Allow running this file directly: `pnpm db:migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../config.js');
  await runMigrations(loadConfig().databaseUrl);
}
