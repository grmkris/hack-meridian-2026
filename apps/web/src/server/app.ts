import { Effect, Layer, Option, Redacted } from 'effect'
import { HttpRouter, HttpServer, HttpServerRequest } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'

import { Api, BadRequest, NotFound, OwnerSession, Unauthorized, Unavailable, type ChainStatus } from '@hm/api'
import { Chain, type ChainHealth } from '@hm/protocol'

import { Counter } from './counter.ts'
import type { DbError } from './db.ts'
import type { Db } from './db.ts'
import type { LedgerError } from './ledger.ts'
import type { Ledger } from './ledger.ts'
import { inviteRequired, Network, type NetworkShape, transferFeeCeiling } from './network.ts'
import type { OAuthGrants } from './oauth-grants.ts'
import { assertionOptions, createWallet, OwnerError, registrationOptions, signIn, walletOfSession } from './owner.ts'
import { revokeConnection } from './revoke.ts'
import { Settings } from './settings.ts'
import {
  connectionsOfWallet,
  contactById,
  contactsOfOwner,
  createContact,
  deleteSession,
  pendingOfWallet,
  receiptsOfWallet,
  replaceDestination,
} from './store.ts'
import { apiGrantView, pendingApproval, revokeUrl } from './views.ts'
import { WalletSettings, type Site } from './wallet-settings.ts'

/** The request's own URL (the Worker hands HttpApi the web Request). */
const requestUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  return request.source instanceof Request
    ? new URL(request.source.url)
    : new URL(request.originalUrl, 'http://localhost')
})

const site = Effect.gen(function* () {
  const url = yield* requestUrl
  const settings = yield* WalletSettings
  return {
    origin: Option.getOrElse(settings.origin, () => url.origin),
    rpId: Option.getOrElse(settings.rpId, () => url.hostname),
  } satisfies Site
})

const cookieOptions = (secure: boolean) => ({
  httpOnly: true,
  secure,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: '30 days' as const,
})

/** Set (or with '' clear) the owner session cookie on this response. */
const setSession = (token: string) =>
  Effect.flatMap(requestUrl, url =>
    HttpApiBuilder.securitySetCookie(OwnerSession, token, cookieOptions(url.protocol === 'https:')),
  )

const fromOwner = (error: OwnerError) =>
  error.kind === 'unauthorized'
    ? new Unauthorized({ error: error.message })
    : error.kind === 'bad_request'
      ? new BadRequest({ error: error.message })
      : new Unavailable({ error: error.message })
const fromStorage = (error: DbError | LedgerError) =>
  new Unavailable({ error: error._tag === 'DbError' ? `storage: ${error.operation}` : error.message })

const sessionWallet = Effect.gen(function* () {
  const token = yield* HttpApiBuilder.securityDecode(OwnerSession)
  const value = Redacted.value(token)
  const wallet = yield* walletOfSession(value === '' ? Option.none() : Option.some(value))
  if (wallet === undefined) return yield* new Unauthorized({ error: 'sign in with your passkey' })
  return wallet
})

const summary = (wallet: { id: string; name: string; contract_id: string; network: string }) => ({
  id: wallet.id,
  name: wallet.name,
  contract_id: wallet.contract_id,
  network: wallet.network,
})

const chainStatus = (fixture: boolean, network: NetworkShape, health: ChainHealth): ChainStatus => ({
  mode: fixture ? 'fixture' : network.name,
  network: network.caip,
  explorer_base: network.explorerBase,
  payments_enabled: network.caps.paymentsEnabled,
  latest_ledger: health.latestLedger,
  relayers: health.relayers.map(relayer => ({ address: relayer.address, xlm: relayer.xlmStroops.toString() })),
  treasury:
    health.treasury === null
      ? null
      : {
          address: health.treasury.address,
          usdc: health.treasury.usdcStroops.toString(),
          xlm: health.treasury.xlmStroops.toString(),
        },
  rent_factor: health.rentFactor,
  contracts: (health.contracts ?? []).map(contract => ({
    name: contract.name,
    id: contract.id,
    live_until_ledger: contract.liveUntilLedger,
    ledgers_left: contract.ledgersLeft,
  })),
})

const SystemHandlers = HttpApiBuilder.group(
  Api,
  'system',
  Effect.fn(function* (handlers) {
    const settings = yield* Settings
    const wallet = yield* WalletSettings
    const network = yield* Network
    const chain = yield* Chain
    return handlers.handle('health', () =>
      Effect.gen(function* () {
        const fee_ceilings = {
          first_xlm: Number(yield* transferFeeCeiling(network, false)) / 1e7,
          later_xlm: Number(yield* transferFeeCeiling(network, true)) / 1e7,
        }
        const health = yield* chain.health.pipe(
          Effect.map(reading => ({ ...chainStatus(wallet.chain === 'fixture', network, reading), fee_ceilings })),
          Effect.timeoutOrElse({ duration: '6 seconds', orElse: () => Effect.succeed(null) }),
          Effect.catchTag('ChainError', error => Effect.as(Effect.logWarning('health', error.message), null)),
        )
        return {
          ok: true as const,
          stage: settings.stage,
          release: settings.release,
          network: settings.network,
          chain: health,
          invite_required: inviteRequired(network),
        }
      }),
    )
  }),
)

const CounterHandlers = HttpApiBuilder.group(
  Api,
  'counter',
  Effect.fn(function* (handlers) {
    const counter = yield* Counter
    return handlers.handle('read', () => counter.read)
  }),
)

const SessionHandlers = HttpApiBuilder.group(
  Api,
  'session',
  Effect.fn(function* (handlers) {
    const context = yield* Effect.context<Db | Chain | WalletSettings | Network>()
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, context)
    return handlers
      .handle('current', () =>
        run(sessionWallet).pipe(
          Effect.map(wallet => ({ wallet: summary(wallet) })),
          Effect.catchTag('DbError', error => Effect.fail(fromStorage(error))),
        ),
      )
      .handle('registrationOptions', ({ payload }) =>
        run(Effect.flatMap(site, here => registrationOptions(here, payload.name, payload.invite_code))).pipe(
          Effect.mapError(fromOwner),
        ),
      )
      .handle('createWallet', ({ payload }) =>
        run(
          Effect.flatMap(site, here =>
            createWallet(here, {
              name: payload.name,
              credentialId: payload.credential_id,
              publicKey: payload.public_key,
              clientDataJSON: payload.client_data_json,
              inviteCode: payload.invite_code,
            }),
          ),
        ).pipe(
          Effect.mapError(fromOwner),
          Effect.tap(created => setSession(created.token)),
          Effect.map(created => ({ wallet: summary(created.wallet) })),
        ),
      )
      .handle('assertionOptions', () => run(Effect.flatMap(site, assertionOptions)).pipe(Effect.mapError(fromOwner)))
      .handle('signIn', ({ payload }) =>
        run(
          Effect.flatMap(site, here =>
            signIn(here, {
              credentialId: payload.credential_id,
              clientDataJSON: payload.client_data_json,
              authenticatorData: payload.authenticator_data,
              signature: payload.signature,
            }),
          ),
        ).pipe(
          Effect.mapError(fromOwner),
          Effect.tap(created => setSession(created.token)),
          Effect.map(created => ({ wallet: summary(created.wallet) })),
        ),
      )
      .handle('signOut', () =>
        Effect.gen(function* () {
          const token = Redacted.value(yield* HttpApiBuilder.securityDecode(OwnerSession))
          if (token !== '')
            yield* run(deleteSession(token)).pipe(Effect.catchTag('DbError', error => Effect.fail(fromStorage(error))))
          yield* setSession('')
        }),
      )
  }),
)

const WalletHandlers = HttpApiBuilder.group(
  Api,
  'wallet',
  Effect.fn(function* (handlers) {
    const context = yield* Effect.context<Db | Chain | WalletSettings | Ledger | OAuthGrants | Network>()
    const network = yield* Network
    const run = <A, R>(
      effect: Effect.Effect<A, DbError | LedgerError | Unauthorized | BadRequest | NotFound | Unavailable, R>,
    ) =>
      Effect.provide(effect, context).pipe(
        Effect.catchTags({
          DbError: error => Effect.fail(fromStorage(error)),
          LedgerError: error => Effect.fail(fromStorage(error)),
        }),
      )
    const chain = yield* Chain
    return handlers
      .handle('overview', () =>
        run(
          Effect.gen(function* () {
            const wallet = yield* sessionWallet
            const here = yield* site
            const balances = yield* chain.balances(wallet.contract_id).pipe(
              Effect.map(b => ({ usdc: b.usdc.toString(), xlm: b.xlm.toString() })),
              Effect.catchTag('ChainError', () => Effect.fail(new Unavailable({ error: 'the chain did not answer' }))),
            )
            const connections = yield* connectionsOfWallet(wallet.id)
            const pending = yield* pendingOfWallet(wallet.id)
            return {
              wallet: summary(wallet),
              network: network.caip,
              explorer_base: network.explorerBase,
              balances,
              grants: connections.map(entry => apiGrantView(entry.connection, entry.grant)),
              pending: pending.map(intent => pendingApproval(intent, here.origin)),
              receipts: yield* receiptsOfWallet(wallet.id, 5),
            }
          }),
        ),
      )
      .handle('connections', () =>
        run(
          Effect.gen(function* () {
            const wallet = yield* sessionWallet
            const connections = yield* connectionsOfWallet(wallet.id)
            return connections.map(entry => apiGrantView(entry.connection, entry.grant))
          }),
        ),
      )
      .handle('revokeConnection', ({ params }) =>
        run(
          Effect.gen(function* () {
            const wallet = yield* sessionWallet
            const here = yield* site
            const result = yield* revokeConnection(wallet.id, wallet.contract_id, params.id)
            if (result === undefined || result.connection === undefined)
              return yield* new NotFound({ error: `no connection ${params.id}` })
            return {
              connection: apiGrantView(result.connection, result.grant),
              approve_url:
                result.grant !== undefined && result.grant.rule_status !== 'removed'
                  ? revokeUrl(here.origin, params.id)
                  : null,
            }
          }),
        ),
      )
      .handle('contacts', () => run(Effect.flatMap(sessionWallet, wallet => contactsOfOwner(wallet.owner_id))))
      .handle('createContact', ({ payload }) =>
        run(
          Effect.gen(function* () {
            const wallet = yield* sessionWallet
            const readiness = yield* chain.readiness(payload.address).pipe(
              Effect.map(r => (r === 'contract' ? ('usdc_ready' as const) : r)),
              Effect.catchTag('ChainError', () => Effect.succeed('unverified' as const)),
            )
            if (!/^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u.test(payload.address))
              return yield* new BadRequest({ error: 'not a Stellar address (C…, G… or M…)' })
            return yield* createContact({
              ownerId: wallet.owner_id,
              displayName: payload.display_name.trim(),
              aliases: payload.aliases ?? [],
              address: payload.address,
              memo: payload.memo ?? null,
              readiness,
            })
          }),
        ),
      )
      .handle('changeContactDestination', ({ params, payload }) =>
        run(
          Effect.gen(function* () {
            const wallet = yield* sessionWallet
            if ((yield* contactById(wallet.owner_id, params.id)) === undefined)
              return yield* new NotFound({ error: `no contact ${params.id}` })
            if (!/^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u.test(payload.address))
              return yield* new BadRequest({ error: 'not a Stellar address (C…, G… or M…)' })
            const readiness = yield* chain.readiness(payload.address).pipe(
              Effect.map(r => (r === 'contract' ? ('usdc_ready' as const) : r)),
              Effect.catchTag('ChainError', () => Effect.succeed('unverified' as const)),
            )
            const contact = yield* replaceDestination({
              ownerId: wallet.owner_id,
              contactId: params.id,
              address: payload.address,
              memo: payload.memo ?? null,
              readiness,
            })
            return contact === undefined ? yield* new NotFound({ error: `no contact ${params.id}` }) : contact
          }),
        ),
      )
      .handle('receipts', () => run(Effect.flatMap(sessionWallet, wallet => receiptsOfWallet(wallet.id, 100))))
      .handle('pending', () =>
        run(
          Effect.gen(function* () {
            const wallet = yield* sessionWallet
            const here = yield* site
            return (yield* pendingOfWallet(wallet.id)).map(intent => pendingApproval(intent, here.origin))
          }),
        ),
      )
  }),
)

export type ApiServices = Settings | Counter | WalletSettings | Db | Chain | Ledger | OAuthGrants | Network

/**
 * The typed API as a fetch handler over the given services. Build it once per isolate. Services that fail to build
 * (a missing setting) answer every request with a 500 and log why.
 */
export const makeApiHandler = <E>(services: Layer.Layer<ApiServices, E>) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide([SystemHandlers, CounterHandlers, SessionHandlers, WalletHandlers]),
      Layer.provide(services),
      Layer.provide(HttpServer.layerServices),
    ),
  )

/** The deployed counter service: settings from the Worker's bindings and the counter on Soroban RPC. */
export const counterServices = (bindings: object) =>
  Counter.layer.pipe(Layer.provideMerge(Settings.fromBindings(bindings)))
