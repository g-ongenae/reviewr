import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from './config.js';

/**
 * Apply the global settings shared by the server and the end-to-end tests.
 */
export const configureApp = (app: NestFastifyApplication, config: Pick<AppConfig, 'corsOrigin'>): void => {
  app.enableCors({ origin: config.corsOrigin, methods: ['GET', 'POST', 'PUT', 'DELETE'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
};
