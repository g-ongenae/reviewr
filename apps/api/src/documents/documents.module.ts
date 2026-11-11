import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { LegacyTitleInterceptor } from './legacy-title.interceptor.js';

/**
 * Documents feature: CRUD and revision history.
 */
@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService, { provide: APP_INTERCEPTOR, useClass: LegacyTitleInterceptor }],
})
export class DocumentsModule {}
