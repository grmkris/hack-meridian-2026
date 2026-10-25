import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'worker', include: ['src/server/**/*.test.ts'], environment: 'node' },
})
