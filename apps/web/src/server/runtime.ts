import { ConfigProvider, Layer, ManagedRuntime } from 'effect'

import { Chain, makeFixtureChain } from '@hm/protocol'
import { stellarLayer } from '@hm/stellar'

import { Counter } from './counter.ts'
import { Db, d1Engine } from './db.ts'
import type { Ledger } from './ledger.ts'
import { Network } from './network.ts'
import { type GrantHelpers, OAuthGrants } from './oauth-grants.ts'
import { Settings } from './settings.ts'
import { ledgerViaObject, type WalletObject } from './wallet-object.ts'
import { parseDemoContacts, stringBindings, WalletSettings } from './wallet-settings.ts'

/** The Worker's bindings (apps/web/alchemy.run.ts). */
export interface WorkerEnv {
  readonly ASSETS: Fetcher
  readonly WALLET_DB: D1Database
  readonly WALLET_OBJECT: DurableObjectNamespace<WalletObject>
  readonly OAUTH_STORE: DurableObjectNamespace<import('./kv-shim.ts').OAuthStore>
  readonly CHAIN?: string
  readonly DEMO_CONTACTS?: string
}

export type AppServices = Settings | Counter | WalletSettings | Db | Chain | Ledger | OAuthGrants | Network
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

export const appLayer = (env: WorkerEnv, helpers: GrantHelpers) =>
  Layer.mergeAll(
    Counter.layer,
    WalletSettings.fromBindings(env),
    Db.fromEngine(d1Engine(env.WALLET_DB)),
    ledgerViaObject(env.WALLET_OBJECT),
    chainLayer(env),
    OAuthGrants.fromHelpers(helpers),
  ).pipe(Layer.provideMerge(Settings.fromBindings(env)))

export const makeRuntime = (env: WorkerEnv, helpers: GrantHelpers): AppRuntime =>
  ManagedRuntime.make(appLayer(env, helpers))
