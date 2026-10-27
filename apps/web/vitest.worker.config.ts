import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'worker',
    include: ['src/server/**/*.test.ts'],
    environment: 'node',
    // Exercise the real provider while replacing only its Cloudflare host class in Node tests.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
})
