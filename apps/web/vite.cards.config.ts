import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

import { foldkit } from '@foldkit/vite-plugin'

/**
 * The MCP Apps card as one self-contained HTML file (scripts, styles and fonts inlined: hosts give it an empty CSP).
 * `scripts/cards.ts build` runs this, then seals the result into `src/server/cards/card.html`. With `--mode harness` it
 * builds the local test host instead (`src/card/harness/`, never committed), which iframes that sealed card.
 */
const OUT = fileURLToPath(new URL('../../.local/cards/', import.meta.url))

export default defineConfig(({ mode }) => {
  const isHarness = mode === 'harness'
  return {
    root: fileURLToPath(new URL(isHarness ? './src/card/harness/' : './src/card/', import.meta.url)),
    publicDir: false,
    base: './',
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [foldkit({ devToolsMcpPort: false }), viteSingleFile()],
    build: {
      outDir: `${OUT}${isHarness ? 'harness' : 'card'}`,
      emptyOutDir: true,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      reportCompressedSize: false,
    },
  }
})
