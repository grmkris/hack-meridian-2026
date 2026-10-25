import { Effect, Layer, ManagedRuntime } from 'effect'

import { Chain, makeFixtureChain } from '@hm/protocol'

import { Counter } from './counter.ts'
import { Db, d1Engine } from './db.ts'
import type { Ledger } from './ledger.ts'
import { type GrantHelpers, OAuthGrants } from './oauth-grants.ts'
import { Settings } from './settings.ts'
import { ledgerViaObject, type WalletObject } from './wallet-object.ts'
import { WalletSettings } from './wallet-settings.ts'

/** The Worker's bindings (apps/web/alchemy.run.ts). */
export interface WorkerEnv {
  readonly ASSETS: Fetcher
  readonly WALLET_DB: D1Database
  readonly WALLET_OBJECT: DurableObjectNamespace<WalletObject>
  readonly OAUTH_STORE: DurableObjectNamespace<import('./kv-shim.ts').OAuthStore>
  readonly CHAIN?: string
}

export type AppServices = Settings | Counter | WalletSettings | Db | Chain | Ledger | OAuthGrants
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>

/**
 * The Chain for this isolate: the fixture (one in-memory ledger shared by /mcp, the pages and /api, lenient about
 * state an isolate restart lost) or Stellar testnet.
 */
const chainLayer = (env: WorkerEnv) =>
  env.CHAIN === 'testnet'
    ? Layer.effect(
        Chain,
        Effect.die(new Error('CHAIN=testnet: @hm/stellar is not wired into this build yet (stream A2)')),
      )
    : Layer.succeed(Chain, makeFixtureChain({ lenient: true }).chain)

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
