import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['apps/web/vitest.config.ts', 'apps/web/vitest.worker.config.ts', 'packages/stellar/vitest.config.ts'],
  },
})
