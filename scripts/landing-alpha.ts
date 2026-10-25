import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

/**
 * Derive real transparency from the checked-in luminance etchings. Safari can interpret a JPEG luminance mask as
 * alpha, leaving a solid rectangle; a WebP with the ink in its alpha channel works in either mask implementation.
 * Run `heavy bun scripts/landing-alpha.ts` after changing a source JPG with landing-art.ts.
 */
const directory = resolve(import.meta.dir, '../apps/web/src/assets/landing')
for (const fileName of (await readdir(directory)).filter(candidate => candidate.endsWith('.jpg')).toSorted()) {
  const { data, info } = await sharp(resolve(directory, fileName))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const output = fileName.replace(/\.jpg$/u, '.webp')
  await sharp({ create: { width, height, channels: 3, background: '#fff' } })
    .joinChannel(data, { raw: { width, height, channels: 1 } })
    .webp({ lossless: true })
    .toFile(resolve(directory, output))
  console.log(`${fileName} → ${output} (${width}×${height})`)
}
