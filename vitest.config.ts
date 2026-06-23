import { defineConfig } from 'vitest/config';

// Root config — only used for IDE / single-shot debugging.
// Each package has its own vitest.config.ts so `pnpm -r run test` is correct.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts'],
    // E2E tests spawn tsx subprocesses (~1.2s each); lifecycle tests chain
    // many commands in a single test, so they need generous timeouts.
    testTimeout: 60000,
  },
});
