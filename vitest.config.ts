import { defineConfig } from 'vitest/config';

// Root config — only used for IDE / single-shot debugging.
// Each package has its own vitest.config.ts so `pnpm -r run test` is correct.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts'],
  },
});
