import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database and reset it per test, so files run serially.
    // Concurrency is exercised *inside* tests, against the real database.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
