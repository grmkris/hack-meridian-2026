import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'tooling', include: ['scripts/**/*.test.ts'], environment: 'node' } },
      'apps/web/vitest.config.ts',
      'apps/web/vitest.worker.config.ts',
      'packages/stellar/vitest.config.ts',
    ],
  },
})
