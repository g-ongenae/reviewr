const defaultPort: number = 3000;
const decimal: number = 10;

/**
 * Runtime configuration, read from environment variables.
 */
export interface AppConfig {
  /** Interface to listen on. */
  host: string;
  port: number;
  databaseUrl: string;
  /** Origins allowed by CORS. `true` allows any origin. */
  corsOrigin: string[] | true;
  runMigrations: boolean;
}

/**
 * Read the configuration from `process.env` (see `.env.example`).
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const corsOrigin: string = env.CORS_ORIGIN ?? 'http://localhost:5173';

  return {
    host: env.HOST ?? '0.0.0.0',
    port: env.PORT === undefined ? defaultPort : Number.parseInt(env.PORT, decimal),
    databaseUrl: env.DATABASE_URL ?? 'postgres://reviewr:reviewr@localhost:5432/reviewr',
    corsOrigin:
      corsOrigin.trim() === '*'
        ? true
        : corsOrigin
            .split(',')
            .map((origin: string) => origin.trim())
            .filter((origin: string) => origin.length > 0),
    runMigrations: env.RUN_MIGRATIONS !== 'false',
  };
};
