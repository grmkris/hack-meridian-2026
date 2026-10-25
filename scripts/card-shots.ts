import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

/**
 * Looks at the MCP Apps card in every state, the way a chat shows it: the harness host (built by `bun scripts/cards.ts
 * harness`) iframes the sealed card.html and plays a fixture. Light and dark, 390 and 720 px. Fails on page errors,
 * console errors, a CSP violation or sideways overflow inside the card; screenshots go to .local/card-shots/.
 *
 *   bun scripts/card-shots.ts [state …]
 */
const ROOT = resolve(import.meta.dir, '..')
const HARNESS = join(ROOT, '.local/cards/harness/index.html')
const OUT = join(ROOT, '.local/card-shots')
const STATES = [
  'payment-needs-nod',
  'payment-ready',
  'payment-paying',
  'payment-receipt',
  'payment-claim',
  'payment-failed',
  'payment-expired',
  'purchase-paid',
  'purchase-needs-nod',
  'purchase-refused',
  'mcp-paid',
  'wallet',
  'wallet-no-allowance',
  'allowance-link',
  'revoked-pending',
  'home',
  'tool-error',
]
const THEMES = ['light', 'dark'] as const
const WIDTHS = [390, 720] as const

const html = readFileSync(HARNESS, 'utf8')
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) })
const states = process.argv.length > 2 ? process.argv.slice(2) : STATES
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const failures: Array<string> = []
try {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: width + 32, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      })
      for (const state of states) {
        const page = await context.newPage()
        const problems: Array<string> = []
        page.on('pageerror', error => problems.push(`page error: ${error.message}`))
        page.on('console', message => {
          if (message.type() === 'error' || message.text().includes('Content Security Policy')) {
            problems.push(`console: ${message.text()}`)
          }
        })
        await page.goto(`${server.url.href}?state=${state}&theme=${theme}&width=${width + 32}`)
        await page.waitForSelector('body[data-ready="true"]', { timeout: 10_000 })
        const frame = page.frames().find(candidate => candidate !== page.mainFrame())
        if (frame !== undefined) {
          const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
          if (overflow > 0) problems.push(`card scrolls sideways by ${overflow}px`)
        }
        const file = join(OUT, `${state}-${theme}-${width}.png`)
        await page.locator('#slot').screenshot({ path: file })
        console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${state} ${theme} ${width} → ${file}`)
        for (const problem of problems) console.log(`  ${problem}`)
        failures.push(...problems.map(problem => `${state} ${theme} ${width}: ${problem}`))
        await page.close()
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
  await server.stop(true)
}
process.exit(failures.length === 0 ? 0 : 1)
