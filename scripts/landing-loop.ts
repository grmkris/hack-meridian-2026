import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * heavy bun scripts/landing-loop.ts
 *
 * The original 7.5-second shot ends with the bird at the window. Overlap its final 1.5 seconds with its first
 * 1.5 seconds, then start the loop at source time 1.5. The six-second result wraps between adjacent source frames
 * instead of jumping from the window to mid-flight. H.264/yuv420p and faststart preserve iPhone playback.
 */
const root = resolve(import.meta.dir, '..')
const source = resolve(root, 'apps/web/public/landing/night-flight.mp4')
const destination = resolve(root, 'apps/web/public/landing/night-flight-loop.mp4')
assert.equal(
  createHash('sha256').update(readFileSync(source)).digest('hex'),
  '2d0b0ad18e6015d988a40427692c511597b5805622d7acb3b0cfe7533fed9009',
  'The source changed; inspect its duration and motion before choosing a new overlap.',
)
const rendered = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-i',
    source,
    '-filter_complex_threads',
    '2',
    '-filter_complex',
    '[0:v]split[main][head];[main]trim=start=1.5,setpts=PTS-STARTPTS[a];[head]trim=end=1.5,setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=1.5:offset=4.5,format=yuv420p[v]',
    '-map',
    '[v]',
    '-an',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-preset',
    'slow',
    '-crf',
    '22',
    '-movflags',
    '+faststart',
    destination,
  ],
  { stdio: 'inherit' },
)
assert.equal(rendered.status, 0, 'ffmpeg must finish the loop')
console.log(destination)
