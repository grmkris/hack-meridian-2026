import { ConfigProvider, Effect, Layer, ManagedRuntime, Option, Redacted, References } from 'effect'

import { Chain, makeFixtureChain } from '@hm/protocol'
import { stellarLayer } from '@hm/stellar'

import { backfilledDb } from './backfill.ts'
import { Counter } from './counter.ts'
import { Db, d1Engine } from './db.ts'
import { EventsHost } from './events/host.ts'
import type { Ledger } from './ledger.ts'
import { Network } from './network.ts'
import { type GrantHelpers, OAuthGrants } from './oauth-grants.ts'
import { logFailure, logLevelOf, structuredLoggerLayer } from './observe/log.ts'
import { Settings } from './settings.ts'
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
  /** `local`, `testnet`, `mainnet` (alchemy.run.ts): the `stage` of every log line. */
  readonly STAGE?: string
  /** `Debug`, `Info`, `Warn`, `Error`; unset = `Info` (alchemy.run.ts sets `Warn` on the local stage). */
  readonly LOG_LEVEL?: string
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
        Effect.catch(error => logFailure('warn', 'events.poke_failed', error, { wallet_id: walletId })),
      ),
    vaultKey: vaultKey === undefined || vaultKey === '' ? Option.none() : Option.some(Redacted.make(vaultKey)),
  })
}

/** The wallet-creation caps: the log in the OAuthStore Durable Object, limits from the bindings (wallet-caps.ts). */
const walletCaps = (env: WorkerEnv) =>
  WalletCaps.fromStore((visitor, limits, take) =>
    env.OAUTH_STORE.getByName('oauth').walletCreation(visitor, limits, take),
  ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(stringBindings(env)))))

export const appLayer = (env: WorkerEnv, helpers: GrantHelpers) =>
  backfilledDb.pipe(
    Layer.provide(Db.fromEngine(d1Engine(env.WALLET_DB))),
    Layer.provideMerge(
      Layer.mergeAll(
        Counter.layer,
        WalletSettings.fromBindings(env),
        ledgerViaObject(env.WALLET_OBJECT),
        chainLayer(env),
        OAuthGrants.fromHelpers(helpers),
        eventsHost(env),
        walletCaps(env),
      ),
    ),
    Layer.provideMerge(Settings.fromBindings(env)),
  )

/**
 * Every `Effect.log*` of this isolate as one JSON line (observe/log.ts), at LOG_LEVEL and above. Replaces Effect's
 * default pretty logger, which would print causes and messages verbatim.
 */
export const loggingLayer = (env: Pick<WorkerEnv, 'STAGE' | 'LOG_LEVEL'>) =>
  Layer.merge(
    structuredLoggerLayer({ app: 'nod', stage: env.STAGE ?? 'unknown' }),
    Layer.succeed(References.MinimumLogLevel, logLevelOf(env.LOG_LEVEL).effect),
  )

export const makeRuntime = (env: WorkerEnv, helpers: GrantHelpers): AppRuntime =>
  ManagedRuntime.make(Layer.merge(appLayer(env, helpers), loggingLayer(env)))
