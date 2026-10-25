import { ConfigProvider, Effect, Layer, ManagedRuntime, Option, Redacted } from 'effect'

import { Chain, makeFixtureChain } from '@hm/protocol'
import { stellarLayer } from '@hm/stellar'

import { Counter } from './counter.ts'
import { Db, d1Engine } from './db.ts'
import { EventsHost } from './events/host.ts'
import type { Ledger } from './ledger.ts'
import { Network } from './network.ts'
import { type GrantHelpers, OAuthGrants } from './oauth-grants.ts'
import { Settings } from './settings.ts'
import { backfillNetwork } from './store.ts'
import { WalletCaps } from './wallet-caps.ts'
import { ledgerViaObject, type WalletObject } from './wallet-object.ts'
import { parseDemoContacts, stringBindings, WalletSettings } from './wallet-settings.ts'

/** The Worker's bindings (apps/web/alchemy.run.ts). */
export interface WorkerEnv {
  readonly ASSETS: Fetcher
  readonly WALLET_DB: D1Database
  readonly WALLET_OBJECT: DurableObjectNamespace<WalletObject>
  readonly OAUTH_STORE: DurableObjectNamespace<import('./kv-shim.ts').OAuthStore>
  readonly CHAIN?: string
  /** The public origin of a deployed stage; OAuth issuer, resource metadata and links use it when set. */
  readonly ORIGIN?: string
  readonly DEMO_CONTACTS?: string
}

export type AppServices = Settings | Counter | WalletSettings | Db | Chain | Ledger | OAuthGrants | Network | WalletCaps
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>

/** `CHAIN=testnet` (or `stellar`): the real chain, on the network STELLAR_NETWORK picks; anything else: the fixture. */
export const realChain = (env: WorkerEnv) => env.CHAIN === 'testnet' || env.CHAIN === 'stellar'

/**
 * The Chain and its Network for this isolate: @hm/stellar on the configured network (settings and secrets from the
 * bindings), or the fixture (one in-memory ledger shared by /mcp, the pages and /api, lenient about state an isolate
 * restart lost).
 */
const chainLayer = (env: WorkerEnv) => {
  const config = ConfigProvider.layer(ConfigProvider.fromEnvRecord(stringBindings(env)))
  if (realChain(env))
    return Network.fromStellar.pipe(Layer.provideMerge(stellarLayer(fetch.bind(globalThis))), Layer.provide(config))
  const fixture = Layer.succeed(
    Chain,
    makeFixtureChain({
      lenient: true,
      trustlineMissing: parseDemoContacts(env.DEMO_CONTACTS)
        .filter(contact => contact.trustline_required)
        .map(contact => contact.address),
    }).chain,
  )
  return Layer.merge(fixture, Network.fixture.pipe(Layer.provide(config)))
}

/**
 * MCP Events from the Worker: wake a wallet's object to deliver what was just journaled (never fails; its alarm
 * delivers anyway), and the vault key webhook secrets are sealed with.
 */
const eventsHost = (env: WorkerEnv) => {
  const vaultKey = stringBindings(env)['VAULT_KEY']
  return Layer.succeed(EventsHost, {
    poke: walletId =>
      Effect.tryPromise(() => env.WALLET_OBJECT.getByName(walletId).poke(walletId)).pipe(
        Effect.catch(error => Effect.logWarning('events poke failed', walletId, String(error))),
      ),
    vaultKey: vaultKey === undefined || vaultKey === '' ? Option.none() : Option.some(Redacted.make(vaultKey)),
  })
}

/** The wallet-creation caps: the log in the OAuthStore Durable Object, limits from the bindings (wallet-caps.ts). */
const walletCaps = (env: WorkerEnv) =>
  WalletCaps.fromStore((visitor, limits, take) =>
    env.OAUTH_STORE.getByName('oauth').walletCreation(visitor, limits, take),
  ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(stringBindings(env)))))

/** Wallet and contact rows on the stage's network (store.ts backfillNetwork); never fails the isolate. */
const networkBackfill = Layer.effectDiscard(
  Effect.gen(function* () {
    const network = yield* Network
    yield* backfillNetwork(network.caip)
  }).pipe(Effect.catch(error => Effect.logWarning('network backfill failed', error))),
)

export const appLayer = (env: WorkerEnv, helpers: GrantHelpers) =>
  networkBackfill.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Counter.layer,
        WalletSettings.fromBindings(env),
        Db.fromEngine(d1Engine(env.WALLET_DB)),
        ledgerViaObject(env.WALLET_OBJECT),
        chainLayer(env),
        OAuthGrants.fromHelpers(helpers),
        eventsHost(env),
        walletCaps(env),
      ),
    ),
    Layer.provideMerge(Settings.fromBindings(env)),
  )

export const makeRuntime = (env: WorkerEnv, helpers: GrantHelpers): AppRuntime =>
  ManagedRuntime.make(appLayer(env, helpers))
