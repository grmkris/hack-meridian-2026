import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/** Open an approval_url and press Approve with the dev password: `bun client/approve.ts <approval_url> [screenshot-name]`. */
import { chromium } from 'playwright-core'

const ROOT = join(import.meta.dir, '..')
const [url, name = 'approval'] = process.argv.slice(2)
if (!url) throw new Error('usage: approve.ts <approval_url> [screenshot-name]')
const PASSWORD = /^DEV_PASSWORD=(.+)$/mu.exec(readFileSync(join(ROOT, '.dev.vars'), 'utf8'))?.[1]?.trim()
if (!PASSWORD) throw new Error('DEV_PASSWORD missing')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const opened = await page.goto(url)
console.log(`GET ${url} → ${opened?.status()}  h1: ${await page.locator('h1').innerText()}`)
await page.fill('input[name=password]', PASSWORD)
const [response] = await Promise.all([page.waitForNavigation(), page.click('#approve')])
console.log(`POST ${url} → ${response?.status()}  h1: ${await page.locator('h1').innerText()}`)
await page.screenshot({ path: join(ROOT, 'evidence', `${name}.png`), fullPage: true })
await browser.close()
