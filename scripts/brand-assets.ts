import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

import { DAWN, HERO } from '../apps/web/src/page/landing-copy'

/**
 * Draws Nod's link preview and icons from the landing's own etchings, the way the site draws them: the committed ink
 * maps (scripts/landing-art.ts) as luminance masks over the night tokens of apps/web/src/landing.css, with Besley and
 * IBM Plex from Google Fonts. Writes apps/web/public/og.png (1200×630), apple-touch-icon.png (the swallow, 180) and the
 * favicons (the wordmark's n with a lamp dot: favicon-32.png, and favicon.svg wrapping a 64 px render), small icons drawn
 * at 256 px and scaled down so the glyph keeps grey, not coloured, edges. With `--candidates` it writes both marks at
 * 180, 32 and 16 px to .local/brand/ for a look.
 *
 *   bun scripts/brand-assets.ts [--candidates]
 */
const ROOT = resolve(import.meta.dir, '..')
const ASSETS = join(ROOT, 'apps/web/src/assets/landing')
const PUBLIC = join(ROOT, 'apps/web/public')
const candidates = process.argv.includes('--candidates')

/** The tokens of apps/web/src/landing.css :root, in hex for the renderer and the SVG icon. */
const NIGHT = '#0b152c'
const STARLIGHT = '#e6f0fa'
const STARLIGHT_MUTED = '#b7c6d8'
const LAMP = '#f7c15f'

const dataUrl = (file: string): string =>
  `data:image/jpeg;base64,${readFileSync(join(ASSETS, file)).toString('base64')}`

const FONTS =
  '<link href="https://fonts.googleapis.com/css2?family=Besley:wght@700&family=IBM+Plex+Sans:wght@500;600&display=block" rel="stylesheet">'

const page = (width: number, height: number, body: string, css: string): string => `<!doctype html>
<html><head><meta charset="utf-8">${FONTS}<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; background: ${NIGHT}; overflow: hidden; }
  .etching { position: absolute; mask-mode: luminance; mask-size: 100% 100%; mask-repeat: no-repeat; }
  ${css}
</style></head><body>${body}</body></html>`

const night = dataUrl('etching-night-2000.jpg')
const flight = dataUrl('etching-plate-flight.jpg')

const OG = page(
  1200,
  630,
  `<div class="scene"><div class="etching lines"></div><div class="glow"></div></div>
   <div class="copy">
     <p class="mark"><span class="wordmark">nod</span><span class="pill">Stellar</span></p>
     <h1>${HERO.title}</h1>
     <p class="line">${DAWN.line}</p>
   </div>`,
  `.scene { position: absolute; left: 0; bottom: 0; width: 1200px; height: ${Math.round(1200 / 1.7715)}px;
     -webkit-mask-image: linear-gradient(to bottom, rgb(0 0 0 / 0.25), rgb(0 0 0 / 1) 50%); mask-image: linear-gradient(to bottom, rgb(0 0 0 / 0.25), rgb(0 0 0 / 1) 50%); }
   .lines { inset: 0; background: ${STARLIGHT}; opacity: 0.5; mask-image: url('${night}'); }
   .glow { position: absolute; left: 25.8%; top: 83%; width: 300px; height: 300px; translate: -50% -50%; border-radius: 50%;
     background: radial-gradient(closest-side, color-mix(in oklch, ${LAMP} 60%, transparent), color-mix(in oklch, ${LAMP} 16%, transparent) 45%, transparent);
     mix-blend-mode: screen; }
   .copy { position: absolute; left: 72px; top: 64px; width: 600px; color: ${STARLIGHT}; text-shadow: 0 0 24px ${NIGHT}, 0 0 4px ${NIGHT}; }
   .mark { display: flex; align-items: center; gap: 16px; }
   .wordmark { font: 700 44px/1 'Besley', serif; letter-spacing: -0.02em; }
   .pill { font: 500 20px/1 'IBM Plex Sans', sans-serif; color: ${STARLIGHT_MUTED}; padding: 7px 14px; border: 1.5px solid rgb(230 240 250 / 0.35); border-radius: 999px; }
   h1 { margin-top: 36px; font: 700 78px/0.98 'Besley', serif; letter-spacing: -0.025em; }
   .line { margin-top: 24px; font: 500 26px/1.35 'IBM Plex Sans', sans-serif; color: ${STARLIGHT_MUTED}; }`,
)

/** The icons: the swallow on the night (`swallow`) or the wordmark's n with a lamp dot (`letter`). */
const ICONS = {
  swallow: (size: number) =>
    page(
      size,
      size,
      '<div class="tile"><div class="etching bird"></div></div>',
      `.tile { position: absolute; inset: 0; border-radius: ${size * 0.22}px; background: ${NIGHT}; }
       .bird { left: 8%; top: 10%; width: 84%; height: ${84 / (992 / 942)}%; background: ${STARLIGHT}; mask-image: url('${flight}'); }`,
    ),
  letter: (size: number) =>
    page(
      size,
      size,
      '<div class="tile"><span>n</span><i></i></div>',
      `.tile { position: absolute; inset: 0; border-radius: ${size * 0.22}px; background: ${NIGHT}; display: grid; place-items: center; }
       span { font: 700 ${size * 0.86}px/1 'Besley', serif; color: ${STARLIGHT}; transform: translateY(-${size * 0.06}px); }
       i { position: absolute; right: ${size * 0.17}px; bottom: ${size * 0.2}px; width: ${size * 0.14}px; height: ${size * 0.14}px; border-radius: 50%; background: ${LAMP}; }`,
    ),
}

const browser = await chromium.launch()
const shoot = async (html: string, width: number, height: number, transparent: boolean): Promise<Buffer> => {
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await tab.setContent(html, { waitUntil: 'networkidle' })
  await tab.evaluate(() => document.fonts.ready)
  const png = await tab.screenshot({ omitBackground: transparent })
  await tab.close()
  return png
}
const render = async (html: string, width: number, height: number, file: string, transparent = false) => {
  writeFileSync(file, await shoot(html, width, height, transparent))
}
/** A small icon: drawn at 256 px, then scaled down. */
const icon = async (draw: (size: number) => string, size: number): Promise<Buffer> =>
  sharp(await shoot(draw(256), 256, 256, true))
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer()
try {
  if (candidates) {
    const out = join(ROOT, '.local/brand')
    mkdirSync(out, { recursive: true })
    for (const [name, draw] of Object.entries(ICONS)) {
      for (const size of [180, 32, 16]) writeFileSync(join(out, `${name}-${size}.png`), await icon(draw, size))
    }
    await render(OG, 1200, 630, join(out, 'og.png'))
    console.log(`candidates in ${out}`)
  } else {
    await render(OG, 1200, 630, join(PUBLIC, 'og.png'))
    writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), await icon(ICONS.swallow, 180))
    writeFileSync(join(PUBLIC, 'favicon-32.png'), await icon(ICONS.letter, 32))
    const svgIcon = (await icon(ICONS.letter, 64)).toString('base64')
    writeFileSync(
      join(PUBLIC, 'favicon.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,${svgIcon}"/></svg>\n`,
    )
    console.log('wrote og.png, apple-touch-icon.png, favicon-32.png, favicon.svg')
  }
} finally {
  await browser.close()
}
writeFileSync(
  join(ROOT, '.local/brand-assets.json'),
  `${JSON.stringify({ at: new Date().toISOString(), candidates })}\n`,
)
