import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HealthController } from './health/health.controller.js';

/**
 * Root module.
 */
@Module({
  imports: [DatabaseModule, DocumentsModule],
  controllers: [HealthController],
})
export class AppModule {}
