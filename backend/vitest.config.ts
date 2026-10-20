import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests share one *_test database and count rows, so files must not run concurrently.
    fileParallelism: false,
    include: ['src/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
