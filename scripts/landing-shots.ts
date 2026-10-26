import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

/**
 * Looks at the signed-out landing the way its art has to hold up: phone, tablet, laptop, desktop and wide, light and
 * dark, and with reduced motion. Each look saves its first screen and the whole page to .local/landing-shots/ and
 * fails on page errors, console errors, sideways overflow, or an etching that does not draw as an alpha mask
 * (scripts/landing-alpha.ts). The hero has sign-in and creation actions; a separate check exercises the passkey recovery flow. `scripts/shots.ts`
 * stays the quick phone + desktop check for every page.
 *
 *   bun scripts/landing-shots.ts [local|testnet|<origin>] [path] [label prefix]
 */
const ROOT = resolve(import.meta.dir, '..')
const ORIGINS: Record<string, string> = {
  local: 'http://localhost:18960',
  testnet: 'https://testnet.trynod.si',
}

type Look = Readonly<{
  label: string
  width: number
  height: number
  deviceScaleFactor: number
  isMobile: boolean
  colorScheme: 'light' | 'dark'
  reducedMotion: 'no-preference' | 'reduce'
}>

const look = (label: string, width: number, height: number, deviceScaleFactor: number, isMobile = false) => ({
  light: {
    label: `${label}-light`,
    width,
    height,
    deviceScaleFactor,
    isMobile,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  } as const,
  dark: {
    label: `${label}-dark`,
    width,
    height,
    deviceScaleFactor,
    isMobile,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  } as const,
  still: {
    label: `${label}-still`,
    width,
    height,
    deviceScaleFactor,
    isMobile,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  } as const,
})

const narrow = look('narrow', 320, 740, 2, true)
const phone = look('phone', 390, 844, 3, true)
const tablet = look('tablet', 820, 1180, 2)
const laptop = look('laptop', 1280, 800, 1)
const desktop = look('desktop', 1440, 900, 1)
const wide = look('wide', 1920, 1080, 1)

const LOOKS: ReadonlyArray<Look> = [
  narrow.light,
  phone.light,
  phone.dark,
  phone.still,
  tablet.light,
  laptop.light,
  desktop.light,
  desktop.dark,
  desktop.still,
  wide.light,
]

/** Capture after the hero video and font have settled. */
const SETTLE_MS = 6800

/** A signed-out visit asks the Worker for a session and gets 401; the browser logs that, and it is not a failure. */
const isSignedOutProbe = (text: string, url: string): boolean =>
  text.includes('status of 401') && new URL(url, 'http://unused.invalid').pathname.startsWith('/api/')

const target = process.argv[2] ?? 'local'
const path = process.argv[3] ?? '/'
const only = process.argv[4]
const origin = process.env['HM_URL'] ?? ORIGINS[target] ?? (target.startsWith('http') ? target : undefined)
if (origin === undefined) throw new Error(`no origin for ${target}; pass a stage, an origin, or set HM_URL`)
const stage = ORIGINS[target] === undefined ? 'custom' : target
const directory = join(ROOT, '.local/landing-shots')
mkdirSync(directory, { recursive: true })

const browser = await chromium.launch()
const failures: Array<string> = []
try {
  for (const { label, colorScheme, reducedMotion, ...viewport } of LOOKS) {
    if (only !== undefined && !label.startsWith(only)) continue
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
      colorScheme,
      reducedMotion,
    })
    const page = await context.newPage()
    const problems: Array<string> = []
    page.on('pageerror', error => problems.push(`page error: ${error.message}`))
    page.on('console', message => {
      if (message.type() === 'error' && !isSignedOutProbe(message.text(), message.location().url)) {
        problems.push(`console error: ${message.text()}`)
      }
    })
    page.on('response', response => {
      const url = new URL(response.url())
      if (response.status() >= 400 && !url.pathname.startsWith('/api/')) {
        problems.push(`${response.status()} ${url.pathname}`)
      }
    })
    await page.goto(new URL(path, origin).href, { waitUntil: 'networkidle' })
    await page.waitForTimeout(reducedMotion === 'reduce' ? 300 : SETTLE_MS)

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (overflow > 0) problems.push(`scrolls sideways by ${overflow}px`)

    // Every etching draws through real transparency, so Safari need not interpret an opaque JPEG's luminance.
    const etchings = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.landing-etching')].map(element => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return {
          name: element.dataset['plate'] ?? element.className,
          mobileWhy: element.matches('[data-chapter="why"] > .landing-plate') && window.innerWidth < 768,
          display: style.display,
          mode: style.maskMode,
          image: style.maskImage,
          width: box.width,
          height: box.height,
        }
      }),
    )
    if (etchings.length !== 5) problems.push(`expected 5 etchings, found ${etchings.length}`)
    for (const etching of etchings) {
      if (etching.mobileWhy) {
        if (etching.display !== 'none' || etching.height !== 0) problems.push('mobile Why drawing still takes space')
        continue
      }
      if (etching.display === 'none' || etching.mode !== 'alpha' || !etching.image.startsWith('url(')) {
        problems.push(`etching ${etching.name} is not an alpha mask (mode ${etching.mode}, image ${etching.image})`)
      } else if (etching.width === 0 || etching.height === 0) {
        problems.push(`etching ${etching.name} has no box`)
      }
    }

    const first = join(directory, `${stage}-${label}-first.png`)
    const whole = join(directory, `${stage}-${label}-page.png`)
    await page.screenshot({ path: first })
    // The plates print in as they scroll into view: read the page to its end first, as a visitor would.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(500)
    await page.screenshot({ path: whole, fullPage: true })
    await page.evaluate(() => window.scrollTo(0, 0))

    const size = `${viewport.width}x${viewport.height}`
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${label} ${size} etchings=${etchings.length} → ${first}`)
    for (const problem of problems) console.log(`  ${problem}`)
    failures.push(...problems.map(problem => `${label}: ${problem}`))
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
