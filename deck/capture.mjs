import { chromium } from 'playwright-core'

const browser = await chromium.launch()
const shots = [
  ['home', 'http://127.0.0.1:5180/', 1280, 1000],
  ['landing', 'https://hack-meridian-testnet.kristjan-grm11775.workers.dev/', 1440, 900],
]
for (const [name, url, width, height] of shots) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `deck/img/${name}.png` })
  console.log(name, 'ok')
  await page.close()
}
await browser.close()
