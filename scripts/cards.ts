import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * The MCP Apps card, built and sealed. `build` runs Vite on apps/web/vite.cards.config.ts, pins the inlined script with
 * a CSP hash, stamps a hash of every input into `<meta name="nod-card-inputs">` and writes the committed
 * apps/web/src/server/cards/card.html (the Worker serves it from there, inside Alchemy's build inputs). `check` only
 * recomputes the inputs hash and compares it with the stamp, so the gate is fast and needs no browser build: change an
 * input, run `bun run cards:build`, commit both. `harness` builds the local test host for `scripts/card-shots.ts`.
 *
 *   bun scripts/cards.ts build | check | harness
 */
const ROOT = resolve(import.meta.dir, '..')
const WEB = join(ROOT, 'apps/web')
const CARD = join(WEB, 'src/server/cards/card.html')
const BUILT = join(ROOT, '.local/cards/card/index.html')
/** Hosts load the card on every render; this keeps it well under what they accept. */
const MAX_BYTES = 1_200_000

/** What the built card depends on. Tests and the harness are not inputs: they never reach the card. */
const INPUT_GLOBS: ReadonlyArray<readonly [string, string]> = [
  ['apps/web/src/card', '**/*'],
  ['packages/protocol/src', '**/*.ts'],
]
const INPUT_FILES = ['apps/web/src/format.ts', 'apps/web/vite.cards.config.ts', 'scripts/cards.ts', 'bun.lock']
const isInput = (path: string) => !path.includes('/harness/') && !path.endsWith('.test.ts')

const inputsHash = (): string => {
  const globbed = INPUT_GLOBS.flatMap(([directory, pattern]) =>
    Array.from(new Bun.Glob(pattern).scanSync({ cwd: join(ROOT, directory), onlyFiles: true }), path =>
      relative(ROOT, join(ROOT, directory, path)),
    ),
  )
  const paths = [...globbed, ...INPUT_FILES].filter(isInput).toSorted()
  const hash = createHash('sha256')
  for (const path of paths)
    hash
      .update(`${path}\0`)
      .update(readFileSync(join(ROOT, path)))
      .update('\0')
  return hash.digest('hex')
}

const INPUTS_META = /<meta name="nod-card-inputs" content="([0-9a-f]{64})">/u

const run = (args: Array<string>) => {
  const child = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--config', 'vite.cards.config.ts', ...args], {
    cwd: WEB,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (child.exitCode !== 0) process.exit(child.exitCode ?? 1)
}

const seal = (html: string, inputs: string): string => {
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu), match => match[1] ?? '')
  if (scripts.length === 0) throw new Error('the built card has no inline script')
  const hashes = scripts.map(script => `'sha256-${createHash('sha256').update(script).digest('base64')}'`).join(' ')
  const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="nod-card-inputs" content="${inputs}">`
  if (!html.includes('<meta charset="UTF-8" />')) throw new Error('the built card has no charset meta to seal after')
  return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />${head}`)
}

const sizeOk = (bytes: number) => {
  console.log(`card.html: ${(bytes / 1024).toFixed(1)} KiB (cap ${(MAX_BYTES / 1024).toFixed(0)} KiB)`)
  return bytes <= MAX_BYTES
}

const command = process.argv[2]
if (command === 'build') {
  run([])
  const html = seal(readFileSync(BUILT, 'utf8'), inputsHash())
  if (!sizeOk(Buffer.byteLength(html))) process.exit(1)
  writeFileSync(CARD, html)
  console.log(`wrote ${relative(ROOT, CARD)}`)
} else if (command === 'check') {
  const committed = readFileSync(CARD, 'utf8')
  const stamped = INPUTS_META.exec(committed)?.[1]
  const expected = inputsHash()
  if (!sizeOk(Buffer.byteLength(committed))) process.exit(1)
  if (stamped !== expected) {
    console.log(`card.html is stale (inputs ${expected.slice(0, 12)}, stamped ${stamped?.slice(0, 12) ?? 'none'}).`)
    console.log('Run `bun run cards:build` and commit apps/web/src/server/cards/card.html with your change.')
    process.exit(1)
  }
  console.log('card.html is up to date')
} else if (command === 'harness') {
  run(['--mode', 'harness'])
  console.log('built .local/cards/harness/index.html')
} else {
  console.log('usage: bun scripts/cards.ts build | check | harness')
  process.exit(2)
}
