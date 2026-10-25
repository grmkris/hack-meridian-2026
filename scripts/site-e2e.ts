import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'

/**
 * The owner's path through the site against a running stage, with a real WebAuthn ceremony: Chrome's virtual
 * authenticator (a P-256 platform passkey with user verification) creates the wallet, every page loads without an
 * error, the owner signs out and signs back in with the same passkey. Screenshots and a receipt go to
 * .local/e2e/<stage>/. Each run creates a new wallet on the stage.
 *
 *   bun scripts/site-e2e.ts [local|testnet]      HM_URL overrides the origin
 */
const ROOT = resolve(import.meta.dir, '..')
const ORIGINS: Record<string, string> = {
  local: 'http://localhost:18960',
  testnet: 'https://hack-meridian-testnet.kristjan-grm11775.workers.dev',
}
const PAGES = [
  { path: '/', heading: 'Home' },
  { path: '/connections', heading: 'Connections' },
  { path: '/contacts', heading: 'Contacts' },
  { path: '/receipts', heading: 'Receipts' },
] as const
const STEP_TIMEOUT_MS = 60_000

const stage = process.argv[2] ?? 'local'
const origin = process.env['HM_URL'] ?? ORIGINS[stage]
if (origin === undefined) throw new Error(`no origin for stage ${stage}; set HM_URL`)
const directory = join(ROOT, '.local/e2e', stage)
mkdirSync(directory, { recursive: true })

interface Step {
  readonly name: string
  readonly ok: boolean
  readonly ms: number
  readonly detail: string
}
const steps: Array<Step> = []
const failureShots: { page?: Page } = {}

const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
  const started = performance.now()
  try {
    await run()
    steps.push({ name, ok: true, ms: Math.round(performance.now() - started), detail: 'ok' })
    console.log(`PASS ${name}`)
    return true
  } catch (error) {
    const detail = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
    steps.push({ name, ok: false, ms: Math.round(performance.now() - started), detail })
    console.log(`FAIL ${name}: ${detail}`)
    await failureShots.page
      ?.screenshot({ path: join(directory, `failed-${steps.length}.png`), fullPage: true })
      .catch(() => undefined)
    return false
  }
}

const noAlert = async (page: Page) => {
  const alerts = await page.getByRole('alert').allTextContents()
  if (alerts.length > 0) throw new Error(`the page shows: ${alerts.join(' | ')}`)
}

const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const pageErrors: Array<string> = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.setDefaultTimeout(STEP_TIMEOUT_MS)
  failureShots.page = page

  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })

  const walletName = `E2E ${new Date().toISOString().slice(11, 19)}`
  const created = await step('a new visitor creates a wallet with a passkey', async () => {
    await page.goto(origin)
    await page.getByLabel('Wallet name').fill(walletName)
    await page.getByTestId('create-wallet').click()
    await page.getByRole('heading', { name: 'Home', level: 1 }).or(page.getByRole('alert')).first().waitFor()
    await noAlert(page)
    await page.getByText('Wallet balance').waitFor()
    await noAlert(page)
    await page.screenshot({ path: join(directory, 'home.png'), fullPage: true })
  })

  if (created) {
    for (const { path, heading } of PAGES) {
      await step(`${heading} loads`, async () => {
        await page.getByRole('link', { name: heading, exact: true }).first().click()
        await page.waitForURL(new URL(path, origin).href)
        await page.getByRole('heading', { name: heading, level: 1 }).waitFor()
        await page.waitForLoadState('networkidle')
        await noAlert(page)
        await page.screenshot({ path: join(directory, `${heading.toLowerCase()}.png`), fullPage: true })
      })
    }

    await step('signing out returns to the welcome page', async () => {
      await page.getByRole('button', { name: 'Sign out' }).click()
      await page.getByTestId('sign-in').waitFor()
    })

    await step('the same passkey signs back in, on the page it left', async () => {
      await page.getByTestId('sign-in').click()
      await page.getByRole('navigation', { name: 'Wallet' }).or(page.getByRole('alert')).first().waitFor()
      await page.screenshot({ path: join(directory, 'signed-in-again.png'), fullPage: true })
      await noAlert(page)
    })
  }

  await step('no page errors', async () => {
    if (pageErrors.length > 0) throw new Error(pageErrors.join(' | '))
  })
  await context.close()
} finally {
  await browser.close()
}

const receipt = { stage, origin, at: new Date().toISOString(), steps }
writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`receipt and screenshots: ${directory}`)
process.exit(steps.every(entry => entry.ok) ? 0 : 1)
