import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * The manifest of Nod's bundled skill (apps/web/public/skill/nod-guide/**): one entry per file with its skill URI, the
 * sha256 of its bytes as served and its size, so the Worker can list the skill and hosts can check what they fetched.
 * Writes apps/web/src/server/skill-manifest.json. `--check` rewrites nothing and fails when the committed manifest no
 * longer matches the files, or when the skill breaks its own limits (SKILL.md at most 256 KiB, frontmatter with name
 * and description).
 *
 *   bun scripts/skill-manifest.ts [--check]
 */
const ROOT = resolve(import.meta.dir, '..')
const SKILL_DIR = join(ROOT, 'apps/web/public/skill/nod-guide')
const MANIFEST = join(ROOT, 'apps/web/src/server/skill-manifest.json')
const NAME = 'nod-guide'
const MAX_SKILL_BYTES = 256 * 1024

type Entry = Readonly<{ uri: string; digest: string; size: number }>

const filesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory)
    .toSorted()
    .flatMap(name => {
      const path = join(directory, name)
      return statSync(path).isDirectory() ? filesUnder(path) : [path]
    })

const entryOf = (path: string): Entry => {
  const bytes = readFileSync(path)
  return {
    uri: `skill://${NAME}/${relative(SKILL_DIR, path).split(sep).join('/')}`,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.byteLength,
  }
}

const problems = (entries: ReadonlyArray<Entry>): ReadonlyArray<string> => {
  const skill = entries.find(entry => entry.uri === `skill://${NAME}/SKILL.md`)
  if (skill === undefined) return ['SKILL.md is missing']
  const text = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? ''
  return [
    ...(skill.size > MAX_SKILL_BYTES ? [`SKILL.md is ${skill.size} bytes, above ${MAX_SKILL_BYTES}`] : []),
    ...(new RegExp(`^name: ${NAME}$`, 'mu').test(frontmatter) ? [] : [`SKILL.md frontmatter lacks "name: ${NAME}"`]),
    ...(/^description: \S/mu.test(frontmatter) ? [] : ['SKILL.md frontmatter lacks a description']),
  ]
}

const entries = filesUnder(SKILL_DIR).map(entryOf)
const json = `${JSON.stringify(entries, null, 2)}\n`
const found = problems(entries)
if (found.length > 0) {
  for (const problem of found) console.error(problem)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  const committed = (() => {
    try {
      return readFileSync(MANIFEST, 'utf8')
    } catch {
      return ''
    }
  })()
  if (committed !== json) {
    console.error(`${relative(ROOT, MANIFEST)} is stale: run \`bun scripts/skill-manifest.ts\` and commit it`)
    process.exit(1)
  }
  console.log(`skill manifest: ${entries.length} files, up to date`)
} else {
  writeFileSync(MANIFEST, json)
  console.log(`wrote ${relative(ROOT, MANIFEST)}: ${entries.map(entry => `${entry.uri} ${entry.size} B`).join(', ')}`)
}
