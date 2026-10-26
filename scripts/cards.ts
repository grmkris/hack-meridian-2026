import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

/**
 * The MCP Apps card, built and sealed. `build` runs Vite on apps/web/vite.cards.config.ts, pins the inlined script with
 * a CSP hash, stamps a hash of the card's inputs into `<meta name="nod-card-inputs">` and writes the committed
 * apps/web/src/server/cards/card.html (the Worker serves it from there, inside Alchemy's build inputs).
 *
 * `check` recomputes the inputs hash. Equal to the stamp: up to date, no build. Different: it rebuilds into a temporary
 * directory and passes (with a warning) when the rebuilt card is byte-identical to the committed one apart from the
 * stamp, so an input change that does not change the card (a comment, an unrelated protocol schema) never fails the
 * gate; it fails only when the committed card is really stale. `harness` builds the local test host for
 * `scripts/card-shots.ts`.
 *
 *   bun scripts/cards.ts build | check | harness
 */
const ROOT = resolve(import.meta.dir, '..')
const WEB = join(ROOT, 'apps/web')
const CARD = join(WEB, 'src/server/cards/card.html')
/** Hosts load the card on every render; this keeps it well under what they accept. */
const MAX_BYTES = 1_200_000

/** The card's source: its program, the formatting and protocol code it imports, the build config and this sealer. */
const INPUT_GLOBS: ReadonlyArray<readonly [string, string]> = [
  ['apps/web/src/card', '**/*'],
  ['packages/protocol/src', '**/*.ts'],
]
const INPUT_FILES = [
  'apps/web/src/qr-decode.ts',
  'apps/web/src/format.ts',
  'apps/web/vite.cards.config.ts',
  'scripts/cards.ts',
]
const isInput = (path: string) => !path.includes('/harness/') && !path.endsWith('.test.ts')

/** The packages that end up in the card or shape its bytes, by their resolved version in bun.lock. */
const BUNDLED_PACKAGES = [
  'jsqr',
  'effect',
  'foldkit',
  '@foldkit/vite-plugin',
  '@modelcontextprotocol/ext-apps',
  'vite',
  'vite-plugin-singlefile',
  'rolldown',
  'lightningcss',
]

const lockedVersion = (lock: string, name: string): string => {
  const escaped = name.replaceAll('/', '\\/').replaceAll('.', '\\.')
  const match = new RegExp(`^ {4}"${escaped}": \\["(${escaped}@[^"]+)"`, 'mu').exec(lock)
  return match?.[1] ?? `${name}@unlocked`
}

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
  const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
  for (const name of BUNDLED_PACKAGES) hash.update(`${lockedVersion(lock, name)}\0`)
  return hash.digest('hex')
}

const INPUTS_META = /<meta name="nod-card-inputs" content="([0-9a-f]{64})">/u

/** Vite's single-file build of the card (or the harness) into `outDir`; exits on a failed build. */
const viteBuild = (outDir: string, mode?: string) => {
  const child = Bun.spawnSync(
    [
      'bunx',
      '--bun',
      'vite',
      'build',
      '--config',
      'vite.cards.config.ts',
      '--outDir',
      outDir,
      ...(mode === undefined ? [] : ['--mode', mode]),
    ],
    { cwd: WEB, stdout: 'inherit', stderr: 'inherit' },
  )
  if (child.exitCode !== 0) process.exit(child.exitCode ?? 1)
  return join(outDir, 'index.html')
}

const seal = (html: string, inputs: string): string => {
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu), match => match[1] ?? '')
  if (scripts.length === 0) throw new Error('the built card has no inline script')
  const hashes = scripts.map(script => `'sha256-${createHash('sha256').update(script).digest('base64')}'`).join(' ')
  const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="nod-card-inputs" content="${inputs}">`
  if (!html.includes('<meta charset="UTF-8" />')) throw new Error('the built card has no charset meta to seal after')
  return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />${head}`)
}

/** A sealed card built from the working tree, in a private temporary directory (safe beside other sessions). */
const buildSealed = (inputs: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'nod-card-'))
  try {
    return seal(readFileSync(viteBuild(directory), 'utf8'), inputs)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const sizeOk = (bytes: number) => {
  console.log(`card.html: ${(bytes / 1024).toFixed(1)} KiB (cap ${(MAX_BYTES / 1024).toFixed(0)} KiB)`)
  return bytes <= MAX_BYTES
}

const withoutStamp = (html: string) => html.replace(INPUTS_META, '')

const command = process.argv[2]
if (command === 'build') {
  const html = buildSealed(inputsHash())
  if (!sizeOk(Buffer.byteLength(html))) process.exit(1)
  writeFileSync(CARD, html)
  console.log(`wrote ${relative(ROOT, CARD)}`)
} else if (command === 'check') {
  const committed = readFileSync(CARD, 'utf8')
  if (!sizeOk(Buffer.byteLength(committed))) process.exit(1)
  const expected = inputsHash()
  const stamped = INPUTS_META.exec(committed)?.[1]
  if (stamped === expected) {
    console.log('card.html is up to date')
    process.exit(0)
  }
  console.log(
    `card inputs changed (${expected.slice(0, 12)}, stamped ${stamped?.slice(0, 12) ?? 'none'}); rebuilding to compare`,
  )
  if (withoutStamp(buildSealed(expected)) === withoutStamp(committed)) {
    console.log('card.html is up to date (same bytes); run `bun run cards:build` to refresh its stamp')
    process.exit(0)
  }
  console.log('card.html is stale: the card built from these sources differs from the committed one.')
  console.log('Run `bun run cards:build` and commit apps/web/src/server/cards/card.html with your change.')
  process.exit(1)
} else if (command === 'harness') {
  viteBuild(join(ROOT, '.local/cards/harness'), 'harness')
  console.log('built .local/cards/harness/index.html')
} else {
  console.log('usage: bun scripts/cards.ts build | check | harness')
  process.exit(2)
}
