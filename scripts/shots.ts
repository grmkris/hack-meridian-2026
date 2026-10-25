import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

/**
 * Looks at a running stage the way a person would: phone and desktop, the page loaded and settled. Fails on page
 * errors, console errors, an alert on the page or sideways overflow, and saves a screenshot of each viewport to
 * .local/shots/ for review, PR descriptions and the demo.
 *
 *   bun scripts/shots.ts [local|testnet] [path]
 */
const ROOT = resolve(import.meta.dir, '..')
const ORIGINS: Record<string, string> = {
  local: 'http://localhost:18960',
  testnet: 'https://testnet.trynod.si',
}
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
] as const

/** A signed-out visit asks the Worker for a session and gets 401; the browser logs that, and it is not a failure. */
const isSignedOutProbe = (text: string, url: string): boolean =>
  text.includes('status of 401') && new URL(url, 'http://unused.invalid').pathname.startsWith('/api/')

const stage = process.argv[2] ?? 'local'
const path = process.argv[3] ?? '/'
const origin = process.env['HM_URL'] ?? ORIGINS[stage]
if (origin === undefined) throw new Error(`no origin for stage ${stage}; set HM_URL`)
const directory = join(ROOT, '.local/shots')
mkdirSync(directory, { recursive: true })

const browser = await chromium.launch()
const failures: Array<string> = []
try {
  for (const { name, ...viewport } of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
    })
    const page = await context.newPage()
    const problems: Array<string> = []
    page.on('pageerror', error => problems.push(`page error: ${error.message}`))
    page.on('console', message => {
      if (message.type() === 'error' && !isSignedOutProbe(message.text(), message.location().url)) {
        problems.push(`console error: ${message.text()}`)
      }
    })
    await page.goto(new URL(path, origin).href, { waitUntil: 'networkidle' })
    const alerts = await page.getByRole('alert').allTextContents()
    problems.push(...alerts.map(text => `alert on the page: ${text}`))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (overflow > 0) problems.push(`scrolls sideways by ${overflow}px`)
    const file = join(directory, `${stage}-${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${name} ${viewport.width}x${viewport.height} → ${file}`)
    for (const problem of problems) console.log(`  ${problem}`)
    failures.push(...problems.map(problem => `${name}: ${problem}`))
    await context.close()
  }
} finally {
  await browser.close()
}
writeFileSync(
  join(directory, `${stage}.json`),
  `${JSON.stringify({ stage, origin, path, at: new Date().toISOString(), failures }, null, 2)}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
