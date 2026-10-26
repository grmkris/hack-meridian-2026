import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

/** heavy bun scripts/landing-loop.ts — render the editable approval scene and its still fallback. */
const root = resolve(import.meta.dir, '..')
const project = resolve(root, '.local/landing-film')
const assets = resolve(project, 'assets')
const destination = resolve(root, 'apps/web/public/landing')
mkdirSync(assets, { recursive: true })
cpSync(resolve(root, 'scripts/landing-film'), project, { recursive: true })
cpSync(resolve(root, 'apps/web/src/assets/landing/etching-plate-ledger.webp'), resolve(assets, 'ledger.webp'))
for (const font of ['plex-sans.woff2', 'besley-700.woff2']) {
  cpSync(resolve(root, 'apps/web/public/fonts', font), resolve(assets, font))
}

// Separate the fingertip from the existing seal engraving; all source pixels come from Nod's own artwork.
const fingerMask = Buffer.from(
  '<svg width="992" height="1008"><path fill="white" d="M655 0H940V100L778 235L704 402L625 514L573 550L499 534L462 503L470 449L504 344L546 256L598 134Z"/></svg>',
)
const maskedFinger = await sharp(resolve(root, 'apps/web/src/assets/landing/etching-plate-seal.webp'))
  .composite([{ input: fingerMask, blend: 'dest-in' }])
  .png()
  .toBuffer()
await sharp(maskedFinger)
  .extract({ left: 452, top: 0, width: 488, height: 560 })
  .webp({ lossless: true })
  .toFile(resolve(assets, 'finger.webp'))

const run = (command: string, args: Array<string>): void => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  assert.equal(result.status, 0, `${command} must finish successfully`)
}
const hyperframes = (args: Array<string>): void => run('npx', ['--yes', 'hyperframes@0.8.200', ...args])
hyperframes(['check', project, '--json'])
hyperframes(['render', project, '--quality', 'delivery', '--workers', '2', '--output', resolve(project, 'master.mp4')])
// The hand continues out of the upper edge of this crop. Its last frame has the same composition as its first.
run('ffmpeg', [
  '-y',
  '-i',
  resolve(project, 'master.mp4'),
  '-vf',
  'crop=1600:760:160:280,format=yuv420p',
  '-an',
  '-c:v',
  'libx264',
  '-threads',
  '2',
  '-preset',
  'slow',
  '-crf',
  '21',
  '-movflags',
  '+faststart',
  resolve(destination, 'approval-loop.mp4'),
])
run('ffmpeg', [
  '-y',
  '-i',
  resolve(destination, 'approval-loop.mp4'),
  '-frames:v',
  '1',
  '-c:v',
  'libwebp',
  '-quality',
  '88',
  resolve(destination, 'approval-still.webp'),
])
console.log(resolve(destination, 'approval-loop.mp4'))
