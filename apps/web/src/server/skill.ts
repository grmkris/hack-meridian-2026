import { Effect, Predicate, Schema } from 'effect'

import skillMarkdown from '../../public/skill/nod-guide/SKILL.md?raw'
import errorsMarkdown from '../../public/skill/nod-guide/references/errors.md?raw'
import examplesMarkdown from '../../public/skill/nod-guide/references/examples.md?raw'
import toolsMarkdown from '../../public/skill/nod-guide/references/tools.md?raw'
import manifestJson from './skill-manifest.json'
import { scope, type ToolContext } from './tools.ts'
import { grantRemaining } from './views.ts'

/**
 * Nod's bundled skill (apps/web/public/skill/nod-guide, written by D) over the MCP Skills extension (SEP-2640), after
 * ~/code/myapps/packages/mcp/src/skills.ts: `skills/list` and `skills/get` answer with one entry (the SKILL.md URI, its
 * frontmatter and every file's digest and size from the build-time manifest, scripts/skill-manifest.ts), the files are
 * in `resources/list` and `resources/read` as text/markdown, the `get_guide` tool returns SKILL.md, and the site serves
 * them at /skill/nod-guide/… (with /SKILL.md and /skill redirecting there). The texts are bundled with the Worker, so
 * what it serves is byte for byte what the manifest hashed.
 */

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
export const SKILL_NAME = 'nod-guide'
export const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`
export const SKILL_PATH = `/skill/${SKILL_NAME}/SKILL.md`

const ManifestEntry = Schema.Struct({ uri: Schema.String, digest: Schema.String, size: Schema.Int })
const manifest = Schema.decodeUnknownSync(Schema.Array(ManifestEntry))(manifestJson)

/** Each file: its path inside the skill, its text and what resources/list says about it. */
const FILES = [
  { path: 'SKILL.md', text: skillMarkdown, title: 'Nod guide' },
  { path: 'references/tools.md', text: toolsMarkdown, title: 'Nod guide: the tools' },
  { path: 'references/errors.md', text: errorsMarkdown, title: 'Nod guide: error codes and recovery' },
  { path: 'references/examples.md', text: examplesMarkdown, title: 'Nod guide: worked examples' },
] as const

const uriOf = (path: string) => `skill://${SKILL_NAME}/${path}`

/** SKILL.md's frontmatter field, as written (a plain YAML scalar on one line). */
const frontmatterField = (field: string) => {
  const block = skillMarkdown.split('---')[1] ?? ''
  const line = block.split('\n').find(candidate => candidate.startsWith(`${field}: `))
  return line?.slice(field.length + 2).trim() ?? ''
}

export const skillFrontmatter = { name: frontmatterField('name'), description: frontmatterField('description') }

/** The skills/list and skills/get entry. */
export const skillEntry = {
  uri: SKILL_URI,
  frontmatter: skillFrontmatter,
  resources: manifest.map(entry => ({ uri: entry.uri, digest: entry.digest, size: entry.size })),
}

export const skillText = skillMarkdown

const CACHE = { ttlMs: 300_000, cacheScope: 'public' } as const

/**
 * `skills/list` and `skills/get` (before either lane: they are the same on both). `undefined` for any other method; an
 * unknown skill URI is the JSON-RPC error -32602.
 */
export const answerSkills = (
  method: string,
  params: unknown,
):
  | { readonly result: Record<string, unknown> }
  | { readonly error: { readonly code: number; readonly message: string } }
  | undefined => {
  if (method === 'skills/list') return { result: { resultType: 'complete', skills: [skillEntry], ...CACHE } }
  if (method !== 'skills/get') return undefined
  const uri = Predicate.isObject(params) ? params['uri'] : undefined
  if (uri !== SKILL_URI)
    return { error: { code: -32602, message: 'Unknown skill. Call skills/list for the skill URIs.' } }
  return { result: { resultType: 'complete', skill: skillEntry, ...CACHE } }
}

/** The skill's files in resources/list (clients without the extension can still attach them). */
export const skillResources = FILES.map(file => ({
  uri: uriOf(file.path),
  name: file.path === 'SKILL.md' ? SKILL_NAME : `${SKILL_NAME}/${file.path}`,
  title: file.title,
  description: file.path === 'SKILL.md' ? skillFrontmatter.description : file.title,
  mimeType: 'text/markdown',
}))

/** resources/read of a skill file, or `undefined` when the URI is not one. */
export const readSkillResource = (uri: string) => {
  const file = FILES.find(candidate => uriOf(candidate.path) === uri)
  return file === undefined ? undefined : { contents: [{ uri, mimeType: 'text/markdown', text: file.text }] }
}

const markdown = (text: string) =>
  new Response(text, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  })

/**
 * The site's copy: /skill/nod-guide/<file> as text/markdown with CORS *, and /SKILL.md, /skill and /skill/ as 301s to
 * /skill/nod-guide/SKILL.md (README and llms.txt point at <origin>/SKILL.md). `undefined` for any other path.
 */
export const skillRoute = (request: Request, path: string): Response | undefined => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
  if (path === '/SKILL.md' || path === '/skill' || path === '/skill/' || path === `/skill/${SKILL_NAME}`)
    return Response.redirect(new URL(SKILL_PATH, request.url).toString(), 301)
  const file = FILES.find(candidate => path === `/skill/${SKILL_NAME}/${candidate.path}`)
  return file === undefined ? undefined : markdown(file.text)
}

/** get_guide: SKILL.md as the sentence (the text the AI app reads), the entry and the reference URIs as the value. */
export const getGuide = (ctx: ToolContext) =>
  Effect.gen(function* () {
    const { grant, nowMs } = yield* scope(ctx, false)
    return {
      sentence: skillMarkdown,
      value: {
        uri: SKILL_URI,
        name: skillFrontmatter.name,
        description: skillFrontmatter.description,
        references: FILES.filter(file => file.path !== 'SKILL.md').map(file => uriOf(file.path)),
        grant_remaining: grantRemaining(grant, nowMs),
      },
    }
  })
