import { Effect } from 'effect'

import { randomId, sha256Hex } from '../clock.ts'
import { Network } from '../network.ts'
import { html } from '../pages.ts'
import type { AppRuntime } from '../runtime.ts'
import { siteOf, WalletSettings } from '../wallet-settings.ts'
import type { StartReply } from './model.ts'
import { samplePage } from './page.ts'
import { sampleSecret, type SampleEnv } from './runner-object.ts'

/**
 * /sample (the page), POST /sample/run (start a run: guards, then the SampleRunner's lock and limits) and GET
 * /sample/run/<id> (the log as JSON, polled every 2 s). The request carries nothing the run uses: amounts, recipients
 * and the seller URL are constants, and the visitor is only a hash of cf-connecting-ip for the rate limit.
 */

const DEMO_NAMES = ['Alice', 'Bob', 'Carol']
const RUN_PATH = /^\/sample\/run\/(sr_[0-9a-f]{24})$/u

/** Why this stage cannot run a sample (null: it can). Testnet only, SAMPLE_ENABLED, payments on, bindings present. */
const unavailable = (env: SampleEnv) =>
  Effect.gen(function* () {
    const network = yield* Network
    const settings = yield* WalletSettings
    if (network.name !== 'testnet') return 'Sample runs exist on Stellar testnet only.'
    if (env.SAMPLE_ENABLED === 'false') return 'Sample runs are switched off on this stage.'
    if (!network.caps.paymentsEnabled) return 'Payments are paused on Nod right now, so sample runs are too.'
    if (env.SAMPLE_RUNNER === undefined) return 'This stage has no sample runner.'
    if (sampleSecret(env) === undefined) return 'This stage has no vault key for the demo owner.'
    const names = new Set(settings.demoContacts.map(contact => contact.name))
    if (!DEMO_NAMES.every(name => names.has(name))) return 'This stage has no demo contacts (Alice, Bob and Carol).'
    return null
  })

const chrome = Effect.gen(function* () {
  const network = yield* Network
  return { nonce: (yield* randomId('n')).slice(2), network: network.label, explorerBase: network.explorerBase }
})

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
  })

/** The run's site: the stage's origin (ORIGIN, else this request's) and the RP id links and passkeys bind to. */
const runSite = (request: Request) =>
  Effect.gen(function* () {
    const { origin } = yield* siteOf(request)
    return yield* siteOf(new Request(origin))
  })

const page = (runtime: AppRuntime, request: Request, env: SampleEnv) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const c = yield* chrome
      const site = yield* runSite(request)
      return html(c, samplePage(c, { unavailable: yield* unavailable(env), origin: site.origin }))
    }),
  )

const start = (runtime: AppRuntime, request: Request, env: SampleEnv) =>
  runtime.runPromise(
    Effect.gen(function* () {
      // A form or image cannot send JSON cross-site without a preflight, and a foreign Origin is refused.
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json'))
        return json({ error: 'POST JSON' }, 415)
      const site = yield* runSite(request)
      const from = request.headers.get('origin')
      if (from !== null && from !== site.origin && from !== new URL(request.url).origin)
        return json({ error: 'cross-site start refused' }, 403)
      const reason = yield* unavailable(env)
      if (reason !== null || env.SAMPLE_RUNNER === undefined) return json({ error: reason }, 503)
      const visitor = (yield* sha256Hex(`sample|${request.headers.get('cf-connecting-ip') ?? 'local'}`)).slice(0, 32)
      const runner = env.SAMPLE_RUNNER.getByName('sample')
      const reply = yield* Effect.promise(
        // SAFETY: SampleRunner.start resolves with a StartReply; the RPC stub's type only wraps it (structured clone).
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        () => runner.start(visitor, site) as unknown as Promise<StartReply>,
      )
      if (reply.ok) return json({ id: reply.id }, 202)
      return json(
        { error: reply.message, reason: reply.reason, retry_after_s: reply.retry_after_s, current: reply.current },
        reply.reason === 'busy' ? 409 : 429,
      )
    }),
  )

const status = (env: SampleEnv, id: string) =>
  env.SAMPLE_RUNNER === undefined
    ? Promise.resolve(json({ error: 'no sample runner' }, 503))
    : env.SAMPLE_RUNNER.getByName('sample')
        .status(id)
        .then(run => (run === undefined ? json({ error: `no sample run ${id}` }, 404) : json(run)))

/** Route /sample/*; undefined when the path is not one of them. */
export const sampleRoute = (
  runtime: AppRuntime,
  request: Request,
  path: string,
  env: SampleEnv,
): Promise<Response> | undefined => {
  if (path === '/sample' || path === '/sample/')
    return request.method === 'GET' || request.method === 'HEAD'
      ? page(runtime, request, env)
      : Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
  if (path === '/sample/run')
    return request.method === 'POST'
      ? start(runtime, request, env)
      : Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
  const run = RUN_PATH.exec(path)
  if (run !== null)
    return request.method === 'GET'
      ? status(env, run[1] ?? '')
      : Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
  if (path.startsWith('/sample/')) return Promise.resolve(json({ error: 'not found' }, 404))
  return undefined
}
