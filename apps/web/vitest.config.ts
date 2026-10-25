import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'web',
    include: ['src/**/*.test.ts'],
    exclude: ['src/server/**'],
    environment: 'happy-dom',
    setupFiles: ['./src/vitest-setup.ts'],
    server: { deps: { inline: ['foldkit', '@foldkit/ui', '@foldkit/devtools'] } },
  },
})
