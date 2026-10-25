import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const root = new URL('./', import.meta.url)
const out = new URL('dist/', root)
const png = new URL('dist/png/', root)

const FONTS =
  'https://fonts.googleapis.com/css2?family=Gabarito:wght@600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const inlineFonts = async () => {
  const css = await (await fetch(FONTS, { headers: { 'user-agent': UA } })).text()
  const latin = css.split('/* ').filter(block => block.startsWith('latin */'))
  const blocks = await Promise.all(
    latin.map(async block => {
      const url = block.match(/url\((https:[^)]+)\)/)[1]
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer())
      return '/* ' + block.replace(url, `data:font/woff2;base64,${bytes.toString('base64')}`)
    }),
  )
  return `<style>\n${blocks.join('')}\n</style>`
}

const inlineImages = async html => {
  const srcs = [...new Set([...html.matchAll(/src="(img\/[^"]+)"/g)].map(m => m[1]))]
  const pairs = await Promise.all(srcs.map(async src => [src, (await readFile(new URL(src, root))).toString('base64')]))
  return pairs.reduce((acc, [src, b64]) => acc.replaceAll(`src="${src}"`, `src="data:image/png;base64,${b64}"`), html)
}

const source = await readFile(new URL('index.html', root), 'utf8')
const fonts = await inlineFonts()
const single = (await inlineImages(source)).replace(
  /<link rel="preconnect"[^>]*>\s*<link rel="preconnect"[^>]*>\s*<link\s+rel="stylesheet"\s+href="https:\/\/fonts\.googleapis\.com[^"]*"\s*\/>/,
  fonts,
)
await rm(png, { recursive: true, force: true })
await mkdir(png, { recursive: true })
await writeFile(new URL('nod-deck.html', out), single)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(new URL('nod-deck.html', out).href, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
await page.evaluate(() => document.documentElement.style.setProperty('--s', '1'))
const frames = await page.$$('.frame')
await Promise.all(
  frames.map((frame, i) => frame.screenshot({ path: new URL(`${String(i + 1).padStart(2, '0')}.png`, png).pathname })),
)
await page.emulateMedia({ media: 'print' })
await page.pdf({
  path: new URL('nod-deck.pdf', out).pathname,
  width: '1920px',
  height: '1080px',
  printBackground: true,
  preferCSSPageSize: true,
})
await browser.close()
console.log(`slides ${frames.length}`)
