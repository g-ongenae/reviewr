import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { configureApp } from './app.js';
import { AppModule } from './app.module.js';
import { AppConfig, loadConfig } from './config.js';
import { runMigrations } from './database/migrate.js';

/** 5 MiB: documents can hold up to 1M characters, i.e. up to ~4 MB of UTF-8. */
const bodyLimitBytes: number = 5_242_880;

const config: AppConfig = loadConfig();

if (config.runMigrations) {
  await runMigrations(config.databaseUrl);
}

const app: NestFastifyApplication = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({ bodyLimit: bodyLimitBytes }),
);
configureApp(app, config);
await app.listen(config.port, '0.0.0.0');
new Logger('Bootstrap').log(`Reviewr API listening on ${await app.getUrl()}`);
