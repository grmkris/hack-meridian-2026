import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, webkit } from 'playwright-core'
import sharp from 'sharp'

/**
 * Real rendering and playback, including the phone path and failed/slow media. No wallet is created.
 * heavy bun scripts/landing-media-check.ts http://localhost:18961 [chromium|webkit] [scenario]
 * HM_BROWSER_EXECUTABLE can point to the WebKit binary in the disposable Playwright container.
 */
const origin = process.argv[2] ?? 'http://localhost:18960'
const engineName = process.argv[3] ?? 'chromium'
assert(engineName === 'chromium' || engineName === 'webkit', 'choose chromium or webkit')
const engine = engineName === 'webkit' ? webkit : chromium
const executablePath = process.env['HM_BROWSER_EXECUTABLE']
const browser = await engine.launch(executablePath === undefined ? {} : { executablePath })
const directory = resolve(process.cwd(), '.local/mobile-media')
mkdirSync(directory, { recursive: true })
const results: Array<unknown> = []
const scenarios = ['phone', 'desktop', 'slow', 'blocked', 'missing', 'reduced', 'save-data']
const onlyScenario = process.argv[4]
assert(onlyScenario === undefined || scenarios.includes(onlyScenario), 'choose a known scenario')

try {
  for (const scenario of scenarios.filter(candidate => onlyScenario === undefined || candidate === onlyScenario)) {
    const context = await browser.newContext({
      viewport: scenario === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: scenario !== 'desktop',
      hasTouch: scenario !== 'desktop',
      reducedMotion: scenario === 'reduced' ? 'reduce' : 'no-preference',
    })
    const page = await context.newPage()
    const errors: Array<string> = []
    const videoRequests: Array<string> = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.url().includes('/landing/night-flight-loop.mp4')) videoRequests.push(request.url())
    })
    if (scenario === 'blocked') {
      await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'))
      })
    }
    if (scenario === 'save-data') {
      await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }))
    }
    if (scenario === 'slow' || scenario === 'missing') {
      await page.route('**/landing/night-flight-loop.mp4', async route => {
        if (scenario === 'missing') {
          await route.fulfill({ status: 404, body: '' })
        } else {
          await new Promise(continueRequest => setTimeout(continueRequest, 1800))
          await route.continue()
        }
      })
    }
    await page.goto(origin)
    await page.locator('.landing-plate').first().waitFor({ state: 'visible' })
    const shouldPlay = scenario === 'phone' || scenario === 'desktop' || scenario === 'slow'
    if (shouldPlay) {
      await page.waitForFunction(() => {
        const video = document.querySelector('video')
        return video !== null && video.dataset['playing'] === 'true' && video.currentTime > 0
      })
    } else if (scenario === 'missing') {
      await page.waitForTimeout(800)
      assert(videoRequests.length > 0, `${scenario}: attempted to load media`)
    }
    await page.waitForTimeout(800)
    const video = await page.locator('video').evaluate(element => ({
      source: element.getAttribute('src'),
      visible: getComputedStyle(element).display !== 'none' && getComputedStyle(element).opacity !== '0',
      playing: element.getAttribute('data-playing') === 'true',
      muted: element instanceof HTMLVideoElement && element.muted,
      inline: element instanceof HTMLVideoElement && element.playsInline,
      loop: element instanceof HTMLVideoElement && element.loop,
    }))
    assert.equal(video.playing, shouldPlay, `${scenario}: playback outcome`)
    assert.equal(video.visible, shouldPlay, `${scenario}: only reveal video when playing`)
    assert(video.muted && video.inline && video.loop, `${scenario}: muted inline looping video`)
    if (scenario === 'reduced' || scenario === 'save-data') assert.equal(videoRequests.length, 0, scenario)
    if (!shouldPlay) assert.equal(video.source, null, `${scenario}: release unused source`)
    if (scenario === 'phone' || scenario === 'desktop') {
      const wrap = await page.locator('video').evaluate(async element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('Missing video')
        return new Promise<{ before: number; after: number }>((resolveWrap, rejectWrap) => {
          let before = element.currentTime
          const timedOut = setTimeout(
            () => {
              element.removeEventListener('timeupdate', tick)
              rejectWrap(new Error('The video reached its end without looping.'))
            },
            (element.duration + 2) * 1000,
          )
          const tick = () => {
            if (element.currentTime < before && !element.paused) {
              clearTimeout(timedOut)
              element.removeEventListener('timeupdate', tick)
              resolveWrap({ before, after: element.currentTime })
            }
            before = element.currentTime
          }
          element.addEventListener('timeupdate', tick)
        })
      })
      assert(wrap.before > wrap.after, `${scenario}: observed a natural loop`)
      await page.getByRole('button', { name: 'Pause animation' }).click()
      await page.waitForFunction(() => document.querySelector('video')?.paused === true)
      const pausedAt = await page.evaluate(() => document.querySelector('video')?.currentTime)
      await page.waitForTimeout(250)
      assert.equal(
        await page.evaluate(() => document.querySelector('video')?.currentTime),
        pausedAt,
        'pause holds its frame',
      )
      await page.getByRole('button', { name: 'Play animation' }).click()
      await page.waitForFunction(() => document.querySelector('video')?.paused === false)
    }
    await page.screenshot({ path: `${directory}/${engineName}-${scenario}-hero.png` })

    // Reproduce the iPhone's luminance-as-alpha failure. With an opaque JPG this paints a solid blue rectangle.
    await page.addStyleTag({
      content:
        '.landing-etching { mask-mode: alpha !important; } .landing-plate { animation: none !important; } .landing-plate::after { display: none !important; }',
    })
    const plates = await page.locator('.landing-plate').all()
    const pixels: Array<unknown> = []
    for (const [index, plate] of plates.entries()) {
      await plate.evaluate(async element => {
        const match = /^url\(["']?(.*?)["']?\)$/u.exec(getComputedStyle(element).maskImage)
        if (match?.[1] === undefined) throw new Error('drawing has no image URL')
        const image = new Image()
        image.src = match[1]
        await image.decode()
      })
      await plate.scrollIntoViewIfNeeded()
      await page.evaluate(
        () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      )
      const png = await plate.screenshot({ path: `${directory}/${engineName}-${scenario}-plate-${index}.png` })
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let paper = 0
      let ink = 0
      for (let pixel = 0; pixel < data.length; pixel += info.channels) {
        const red = data[pixel] ?? 0
        const green = data[pixel + 1] ?? 0
        const blue = data[pixel + 2] ?? 0
        if (red > 220 && green > 220 && blue > 220) paper += 1
        if (red < 160 && blue > red + 10) ink += 1
      }
      const total = info.width * info.height
      assert(paper / total > 0.1, `${scenario}: plate ${index} is a filled rectangle`)
      assert(ink / total > 0.01, `${scenario}: plate ${index} is missing its drawing`)
      pixels.push({ index, paper: paper / total, ink: ink / total })
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.equal(overflow, 0, `${scenario}: horizontal overflow`)
    assert.deepEqual(errors, [], `${scenario}: page errors`)
    results.push({ scenario, video, videoRequests: videoRequests.length, pixels })
    console.log(`PASS ${engineName} ${scenario}: video and ${plates.length} rendered drawings`)
    await context.close()
  }
} finally {
  writeFileSync(
    `${directory}/${engineName}-checks.json`,
    `${JSON.stringify({ origin, engine: engineName, version: browser.version(), results }, null, 2)}\n`,
  )
  await browser.close()
}
