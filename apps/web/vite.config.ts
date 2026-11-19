import { execFileSync } from 'node:child_process';
import { readBuildVersion } from '@reviewr/shared';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Which commit is built, and when: compiled into the bundle, read once when the build or dev server starts. */
const buildVersion = readBuildVersion((args) =>
  execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
);

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(JSON.stringify(buildVersion)),
  },
  server: {
    // In development the API is reached through /api, so no CORS setup is needed.
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
});
