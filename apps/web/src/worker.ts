import { env } from 'cloudflare:workers'
import { Layer } from 'effect'

import { getOAuthApi, type OAuthHelpers } from '@cloudflare/workers-oauth-provider'

import { makeApiHandler } from './server/app.ts'
import { canonicalRedirect } from './server/canonical.ts'
import { durableKv } from './server/kv-shim.ts'
import { authorize, OAuthProvider, prepareGrant, providerOptions, serveMcpRequest } from './server/oauth.ts'
import { ownerRoute } from './server/routes.ts'
import { makeRuntime, type WorkerEnv } from './server/runtime.ts'
import { sampleRoute } from './server/sample/route.ts'
import type { SampleEnv } from './server/sample/runner-object.ts'
import { STELLAR_TOML_PATH, stellarToml } from './server/stellar-toml.ts'

export { OAuthStore } from './server/kv-shim.ts'
export { SampleRunner } from './server/sample/runner-object.ts'
export { WalletObject } from './server/wallet-object.ts'

interface Env extends SampleEnv {
  readonly OAUTH_KV: KVNamespace
  readonly OAUTH_PROVIDER: OAuthHelpers
}

/**
 * One Worker: the OAuth provider in front (metadata, DCR, token, /mcp with a bearer), our routes behind it (consent at
 * /authorize, owner pages under /approve and /claim, the typed /api), and the Foldkit SPA's assets for everything else.
 * Services are built once per isolate; the OAuth storage is the Durable Object KV shim (the token has no KV right).
 */
// SAFETY: `env` from cloudflare:workers carries the bindings declared in apps/web/alchemy.run.ts.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const bindings = env as unknown as WorkerEnv
const oauthKv = durableKv(bindings.OAUTH_STORE)

const defaultHandler = {
  fetch(request: Request, requestEnv: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/authorize') return authorize(runtime, request, requestEnv)
    if (path === '/oauth/grant/prepare' && request.method === 'POST') return prepareGrant(runtime, request)
    if (path === STELLAR_TOML_PATH) return stellarToml(request, requestEnv)
    const owner = ownerRoute(runtime, request, path)
    if (owner !== undefined) return owner
    const sample = sampleRoute(runtime, request, path, requestEnv)
    if (sample !== undefined) return sample
    if (path.startsWith('/api/')) return api.handler(request)
    return requestEnv.ASSETS.fetch(request)
  },
}

/** /mcp behind the bearer check. */
const mcp = {
  fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    return serveMcpRequest(runtime, request, ctx)
  },
}

const providers = new Map<string, OAuthProvider<Env>>()
/** One provider per origin: the resource and issuer are the URL the client used (workers.dev or localhost). */
const providerFor = (origin: string) => {
  let provider = providers.get(origin)
  if (provider === undefined) {
    provider = new OAuthProvider<Env>(providerOptions<Env>(origin, mcp, defaultHandler))
    providers.set(origin, provider)
  }
  return provider
}

const withKv = (requestEnv: WorkerEnv): Env => ({
  ...requestEnv,
  OAUTH_KV: oauthKv,
  // SAFETY: OAuthProvider injects OAUTH_PROVIDER into the env it hands our handlers; this placeholder is overwritten.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  OAUTH_PROVIDER: undefined as unknown as OAuthHelpers,
})

const helpers = getOAuthApi(providerOptions<Env>('http://localhost', mcp, defaultHandler), withKv(bindings))
const runtime = makeRuntime(bindings, helpers)
/** /api shares the runtime's services (one fixture ledger, one relayer pool per isolate). */
const api = makeApiHandler(Layer.effectContext(runtime.contextEffect))

export default {
  fetch(request, requestEnv, ctx) {
    // A stage with ORIGIN has one identity: any other host (workers.dev, www) is redirected there first.
    const moved = canonicalRedirect(request, requestEnv.ORIGIN)
    if (moved !== undefined) return moved
    // A deployed stage names its public origin (ORIGIN): the OAuth issuer and the protected-resource metadata are
    // that URL whatever host the request came through; locally the request's own origin.
    const origin =
      requestEnv.ORIGIN === undefined || requestEnv.ORIGIN === '' ? new URL(request.url).origin : requestEnv.ORIGIN
    return providerFor(origin).fetch(request, withKv(requestEnv), ctx)
  },
} satisfies ExportedHandler<WorkerEnv>
