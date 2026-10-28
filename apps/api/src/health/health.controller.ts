import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { databaseToken, type Database } from '../database/database.js';

/**
 * Liveness/readiness probe.
 */
@Controller('health')
export class HealthController {
  /**
   * @param db - Drizzle database
   */
  constructor(@Inject(databaseToken) private readonly db: Database) {}

  /**
   * GET /health: checks the database is reachable.
   */
  @Get()
  public async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException('Database unreachable');
    }

    return { status: 'ok' };
  }
}
