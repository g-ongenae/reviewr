import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { databaseToken, pgPoolToken } from './database.js';
import * as schema from './schema.js';

/**
 * Provides the PostgreSQL connection pool and the Drizzle database to the whole application.
 */
@Global()
@Module({
  providers: [
    {
      provide: pgPoolToken,
      /** Create the pool from `DATABASE_URL`. */
      useFactory: (): pg.Pool => new pg.Pool({ connectionString: loadConfig().databaseUrl }),
    },
    {
      provide: databaseToken,
      inject: [pgPoolToken],
      /** Wrap the pool with Drizzle. */
      useFactory: (pool: pg.Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [databaseToken],
})
export class DatabaseModule implements OnApplicationShutdown {
  /**
   * @param pool - PostgreSQL connection pool
   */
  constructor(@Inject(pgPoolToken) private readonly pool: pg.Pool) {}

  /**
   * Close the connections when the application stops.
   */
  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
