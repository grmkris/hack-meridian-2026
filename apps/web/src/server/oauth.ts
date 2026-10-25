import { Effect, Schema } from 'effect'

import {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
  OAuthProvider,
  type OAuthProviderOptions,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider'
import { Assertion } from '@hm/api'
import { Chain, PreparedOwnerAuth, toStroops } from '@hm/protocol'

import { isoIn, nowIso, nowMillis, randomId } from './clock.ts'
import { serveMcp } from './mcp.ts'
import { OwnerError, checkAssertion, requireWallet, walletOfSession, sessionToken } from './owner.ts'
import { consentGrantPage, consentSignInPage, html, messagePage, type ConsentView } from './pages.ts'
import { ConnectionProps, type ConnectionMetadata } from './props.ts'
import type { AppRuntime } from './runtime.ts'
import { createConnection, createPendingGrant, pendingGrant } from './store.ts'
import { siteOf } from './wallet-settings.ts'

/**
 * OAuth 2.1 for MCP hosts (docs/spikes/s4.md): workers-oauth-provider 1.2.4 with DCR and CIMD, `/mcp` as the API
 * route, scopes `wallet` + `offline_access`, short access tokens, resource metadata per request origin. The consent
 * page at /authorize is the grant ceremony: the owner's passkey signs the context-rule install before
 * completeAuthorization, and one consent = one OAuth grant = one connection = one spending grant.
 */

export const SCOPES = ['wallet', 'offline_access']

export interface ProviderEnv {
  readonly OAUTH_KV: KVNamespace
  readonly OAUTH_PROVIDER: OAuthHelpers
}

const nonce = Effect.map(randomId('n'), id => id.slice(2))

/** A workers-oauth-provider call that threw (AuthorizationError, CimdFetchError, …), kept for the error page. */
class OAuthCallError extends Schema.TaggedError<OAuthCallError>()('OAuthCallError', {
  what: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Run an Effect that renders a page; an OwnerError becomes a message page with the right status. */
export const renderPage = (runtime: AppRuntime, effect: Effect.Effect<Response, unknown>) => runtime.runPromise(effect)

const pageError = (n: string, title: string, error: OwnerError) =>
  html(n, messagePage(n, title, error.message), {
    status: error.kind === 'unauthorized' ? 401 : error.kind === 'bad_request' ? 400 : 503,
  })

const consentView = (handle: string, details: Awaited<ReturnType<OAuthHelpers['describeConsent']>>): ConsentView => ({
  handle,
  clientName: details.clientName,
  clientDomain: details.clientDomain ?? null,
  redirectHost: details.redirectHost,
  redirectIsLoopback: details.redirectIsLoopback,
})

const ALLOWANCE = /^\d{1,6}(\.\d{1,2})?$/u
const MAX_LIFETIME_S = 30 * 86400

const GrantRequest = Schema.Struct({
  handle: Schema.String,
  allowance: Schema.String,
  lifetime_seconds: Schema.Int,
})

/** POST /oauth/grant/prepare: K, its rule install prepared for the owner's passkey (nothing onchain yet). */
export const prepareGrant = (runtime: AppRuntime, request: Request) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const wallet = yield* requireWallet(request)
      const body = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new OwnerError({ kind: 'bad_request', message: 'expected JSON' }),
      })
      const input = yield* Schema.decodeUnknownEffect(GrantRequest)(body).pipe(
        Effect.mapError(
          () => new OwnerError({ kind: 'bad_request', message: 'allowance and lifetime_seconds are required' }),
        ),
      )
      if (!ALLOWANCE.test(input.allowance) || toStroops(input.allowance) <= 0n)
        return yield* new OwnerError({ kind: 'bad_request', message: 'the allowance must be a USDC amount like 5.00' })
      const lifetime = Math.min(Math.max(input.lifetime_seconds, 300), MAX_LIFETIME_S)
      const chain = yield* Chain
      const signer = yield* chain.newSigner
      const total = toStroops(input.allowance)
      const prepared = yield* chain.prepareInstallGrant(wallet.contract_id, signer.publicKey, total, lifetime)
      const encoded = yield* Schema.encodeEffect(PreparedOwnerAuth)(prepared).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared install' })),
      )
      const id = yield* createPendingGrant({
        owner_id: wallet.owner_id,
        wallet_id: wallet.id,
        signer_public_key: signer.address,
        signer_key_ref: signer.signerKeyRef,
        total,
        valid_until: yield* isoIn(lifetime * 1000),
        lifetime_seconds: lifetime,
        prepared: JSON.stringify(encoded),
      })
      return Response.json({ pending_id: id, challenge: prepared.challenge })
    }).pipe(
      Effect.catchTags({
        OwnerError: error =>
          Effect.succeed(
            Response.json(
              { error: error.message },
              { status: error.kind === 'unauthorized' ? 401 : error.kind === 'bad_request' ? 400 : 503 },
            ),
          ),
        ChainError: error => Effect.succeed(Response.json({ error: `chain: ${error.message}` }, { status: 503 })),
        DbError: () => Effect.succeed(Response.json({ error: 'storage failed; retry' }, { status: 503 })),
      }),
    ),
  )

const decodePrepared = Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedOwnerAuth))

/** A form field as text ('' when absent or a file). */
const formText = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

const call = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: cause => new OAuthCallError({ what, cause }) })
const decodeAssertionJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Assertion))

/** /authorize: GET shows sign-in or the grant ceremony; POST denies, or installs the rule then completes. */
export const authorize = (runtime: AppRuntime, request: Request, env: ProviderEnv) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const n = yield* nonce
      const oauth = env.OAUTH_PROVIDER
      const site = yield* siteOf(request)
      if (request.method === 'GET') {
        const authRequest = yield* call('parse', () => oauth.parseAuthRequest(request))
        const details = yield* call('describe', () => oauth.describeConsent(authRequest))
        const consent = yield* call('begin', () => oauth.beginConsent(authRequest))
        const view = consentView(consent.handle, details)
        const wallet = yield* walletOfSession(sessionToken(request))
        if (wallet === undefined) return html(n, consentSignInPage(n, view), { headers: consent.headers })
        const balance = yield* Chain.use(chain => chain.balances(wallet.contract_id)).pipe(
          Effect.map(b => b.usdc),
          Effect.catchTag('ChainError', () => Effect.succeed(null)),
        )
        return html(n, consentGrantPage(n, view, wallet, balance, yield* nowMillis, site.rpId), {
          headers: consent.headers,
        })
      }
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
      const form = yield* call('form', () => request.formData())
      const handle = formText(form, 'handle')
      if (form.get('approve') !== '1') {
        const denied = yield* call('deny', () => oauth.denyConsent(request, handle))
        denied.headers.set('Location', denied.redirectTo)
        return new Response(null, { status: 302, headers: denied.headers })
      }
      const wallet = yield* requireWallet(request)
      const pending = yield* pendingGrant(formText(form, 'pending_id'), wallet.owner_id)
      if (pending === undefined)
        return yield* new OwnerError({
          kind: 'bad_request',
          message: 'this allowance request expired; go back and Allow again',
        })
      const prepared = yield* decodePrepared(pending.prepared).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'bad_request', message: 'the prepared install is unreadable' })),
      )
      const signed = yield* decodeAssertionJson(formText(form, 'assertion')).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'bad_request', message: 'the passkey answer is missing' })),
      )
      const assertion = yield* checkAssertion(
        site,
        wallet,
        {
          credentialId: signed.credential_id,
          clientDataJSON: signed.client_data_json,
          authenticatorData: signed.authenticator_data,
          signature: signed.signature,
        },
        prepared.challenge,
      )
      const chain = yield* Chain
      const installed = yield* chain.installGrant(prepared, assertion)
      const pocket = yield* chain.createPocket(pending.signer_key_ref).pipe(
        Effect.map(created => created.address),
        Effect.catchTag('ChainError', error => Effect.as(Effect.logWarning('pocket not created', error.message), null)),
      )
      const approved = yield* call('approve', () => oauth.approveConsent(request, handle))
      const details = yield* call('describe', () => oauth.describeConsent(approved.request))
      const connectionId = yield* randomId('con')
      const grantId = yield* randomId('gr')
      yield* createConnection({
        connectionId,
        grantId,
        ownerId: wallet.owner_id,
        walletId: wallet.id,
        clientId: approved.request.clientId,
        clientName: details.clientName,
        clientDomain: details.clientDomain ?? null,
        oauthGrantId: connectionId,
        pending,
        ruleId: installed.ruleId,
        validUntilLedger: installed.validUntilLedger,
        installTx: installed.tx,
        pocketAddress: pocket,
      })
      const props: ConnectionProps = {
        owner_id: wallet.owner_id,
        wallet_id: wallet.id,
        connection_id: connectionId,
        client_id: approved.request.clientId,
        client_name: details.clientName,
        client_domain: details.clientDomain ?? null,
        granted_at: yield* nowIso,
        grant: {
          grant_id: grantId,
          allowance: (Number(pending.total) / 1e7).toFixed(2),
          valid_until: pending.valid_until,
          rule_id: installed.ruleId,
          signer_public_key: pending.signer_public_key,
        },
      }
      const metadata: ConnectionMetadata = {
        connection_id: connectionId,
        client_name: details.clientName,
        grant_id: grantId,
        allowance: props.grant.allowance,
        valid_until: pending.valid_until,
      }
      const granted = approved.request.scope.filter(scope => SCOPES.includes(scope))
      const { redirectTo } = yield* call('complete', () =>
        oauth.completeAuthorization({
          request: approved.request,
          userId: wallet.owner_id,
          metadata,
          scope: granted.includes('wallet') ? granted : ['wallet', ...granted],
          props,
          revokeExistingGrants: false,
        }),
      )
      approved.headers.set('Location', redirectTo)
      return new Response(null, { status: 302, headers: approved.headers })
    }).pipe(
      Effect.catch(error =>
        Effect.gen(function* () {
          const n = yield* nonce
          if (error instanceof OwnerError) return pageError(n, 'Cannot connect', error)
          if (typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'ChainError')
            return html(
              n,
              messagePage(
                n,
                'The chain refused',
                'message' in error && typeof error.message === 'string' ? error.message : 'unknown',
              ),
              {
                status: 502,
              },
            )
          if (typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'DbError')
            return html(n, messagePage(n, 'Storage failed', 'Try again in a moment.'), { status: 503 })
          const cause = error instanceof OAuthCallError ? error.cause : error
          if (cause instanceof AuthorizationError && cause.redirectTo) return Response.redirect(cause.redirectTo, 302)
          if (cause instanceof AuthorizationError || cause instanceof CimdFetchError)
            return html(
              n,
              messagePage(
                n,
                'Cannot authorize',
                cause instanceof AuthorizationError
                  ? (cause.description ?? 'invalid request')
                  : 'This app could not be verified.',
              ),
              { status: 400 },
            )
          yield* Effect.logError('authorize failed', cause)
          return html(n, messagePage(n, 'Something went wrong', 'Start connecting again from your app.'), {
            status: 500,
          })
        }),
      ),
    ),
  )

/** The resource handler: /mcp with a valid bearer. ctx.props is decoded, never trusted blindly. */
export const serveMcpRequest = async (
  runtime: AppRuntime,
  request: Request,
  context: ExecutionContext,
): Promise<Response> => {
  {
    // SAFETY: OAuthProvider calls the API handler with an OAuthResourceContext (ExecutionContext + props + auth).
    const ctx = context as OAuthResourceContext<unknown>
    const props = Schema.decodeUnknownOption(ConnectionProps)(ctx.props)
    if (props._tag === 'None')
      return Response.json({ error: 'this token predates the current wallet; reconnect' }, { status: 401 })
    const site = await runtime.runPromise(siteOf(request))
    return serveMcp(
      runtime,
      request,
      { props: props.value, origin: site.origin },
      {
        token: ctx.auth.token,
        clientId: ctx.auth.clientId ?? props.value.client_id,
        scopes: ctx.auth.scope,
        ...(ctx.auth.expiresAt === undefined ? {} : { expiresAt: ctx.auth.expiresAt }),
      },
    )
  }
}

export const providerOptions = <Env>(
  origin: string,
  apiHandler: NonNullable<OAuthProviderOptions<Env>['apiHandler']>,
  defaultHandler: NonNullable<OAuthProviderOptions<Env>['defaultHandler']>,
): OAuthProviderOptions<Env> => ({
  apiRoute: '/mcp',
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: SCOPES,
  requiredScopes: ['wallet'],
  resourceMetadata: {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_name: 'stellarmcpwallet',
  },
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600,
})

export { OAuthProvider }
