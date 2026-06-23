import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // E2E tests spawn tsx subprocesses (~1.2s each); lifecycle tests chain
    // many commands, so they need generous timeouts.
    testTimeout: 60000,
  },
});
