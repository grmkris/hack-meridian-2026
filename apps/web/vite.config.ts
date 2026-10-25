import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

// Under `bun run dev` and a deploy, Alchemy adds the Cloudflare plugin and serves src/worker.ts beside this app.
export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: { entries: ['src/entry.ts'] },
})
