import { Option, Schema } from 'effect'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * HTTP acceptance of a running stage: the app shell, a client route, health, the counter read through Soroban RPC and
 * an unknown API path. Writes a receipt to .local/smoke-<stage>.json and exits 1 if any check fails.
 *
 *   bun scripts/smoke.ts local      against bun run dev (http://localhost:18960)
 *   bun scripts/smoke.ts testnet    against the deployed Worker; HM_URL overrides the origin
 */
const ROOT = resolve(import.meta.dir, '..')
const ORIGINS: Record<string, string> = {
  local: 'http://localhost:18960',
  testnet: 'https://hack-meridian-testnet.kristjan-grm11775.workers.dev',
}
const stage = process.argv[2] ?? 'local'
const origin = process.env['HM_URL'] ?? ORIGINS[stage]
if (origin === undefined) throw new Error(`no origin for stage ${stage}; set HM_URL`)
const deployment = Schema.decodeUnknownSync(
  Schema.Struct({ contracts: Schema.Struct({ counter: Schema.Struct({ id: Schema.String }) }) }),
)(JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/testnet.json'), 'utf8')))

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly status: number
  readonly ms: number
  readonly detail: string
}

const check = async (
  name: string,
  path: string,
  judge: (response: Response, body: string) => string | undefined,
): Promise<Check> => {
  const started = performance.now()
  try {
    const response = await fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const body = await response.text()
    const problem = judge(response, body)
    return {
      name,
      ok: problem === undefined,
      status: response.status,
      ms: Math.round(performance.now() - started),
      detail: problem ?? 'ok',
    }
  } catch (error) {
    return { name, ok: false, status: 0, ms: Math.round(performance.now() - started), detail: String(error) }
  }
}

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const json = (body: string): Record<string, unknown> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(body), () => ({}))

const html = (response: Response, body: string) =>
  response.status !== 200
    ? `status ${response.status}`
    : body.includes('<div id="root">')
      ? undefined
      : 'no app root in the page'

const checks = await Promise.all([
  check('app shell', '/', html),
  check('client route falls back to the app', '/a/client/route', html),
  check('health', '/api/health', (response, body) => {
    const health = json(body)
    if (response.status !== 200) return `status ${response.status}`
    if (health['ok'] !== true) return 'ok is not true'
    return health['stage'] === stage ? undefined : `stage is ${String(health['stage'])}, expected ${stage}`
  }),
  check('counter reads the contract', '/api/counter', (response, body) => {
    const reading = json(body)
    if (response.status !== 200) return `status ${response.status}: ${body.slice(0, 200)}`
    if (reading['contractId'] !== deployment.contracts.counter.id) return `contract ${String(reading['contractId'])}`
    return Number.isInteger(reading['count']) ? undefined : `count is ${String(reading['count'])}`
  }),
  check('unknown API path is a 404', '/api/no-such-endpoint', response =>
    response.status === 404 ? undefined : `status ${response.status}`,
  ),
])

for (const { name, ok, status, ms, detail } of checks)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${status}, ${ms} ms)${ok ? '' : `: ${detail}`}`)
const health = json(await (await fetch(new URL('/api/health', origin)).catch(() => new Response('{}'))).text())
const receipt = { stage, origin, at: new Date().toISOString(), release: health['release'] ?? null, checks }
mkdirSync(join(ROOT, '.local'), { recursive: true })
writeFileSync(join(ROOT, `.local/smoke-${stage}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`receipt: .local/smoke-${stage}.json`)
process.exit(checks.every(result => result.ok) ? 0 : 1)
