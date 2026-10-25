import { Effect, Layer, Option } from 'effect'

import { Chain, type FixtureChain, makeFixtureChain } from '@hm/protocol'

import { Counter } from '../counter.ts'
import { Db } from '../db.ts'
import { Ledger, makeLocalLedger } from '../ledger.ts'
import { OAuthGrants } from '../oauth-grants.ts'
import { Settings } from '../settings.ts'
import { WalletSettings } from '../wallet-settings.ts'
import { sqliteEngine } from './sqlite.ts'

export const testSettings = Layer.succeed(Settings, {
  stage: 'test',
  release: '0123456789abcdef0123456789abcdef01234567',
  network: 'testnet',
  rpcUrl: 'http://rpc.invalid',
  networkPassphrase: 'Test SDF Network ; September 2015',
  counterContractId: Option.none(),
})

export const testWalletSettings = Layer.succeed(WalletSettings, {
  stage: 'test',
  chain: 'fixture',
  rpId: Option.some('wallet.test'),
  origin: Option.some('https://wallet.test'),
  welcomeUsdc: 100_000_000n,
})

/**
 * Every service the Worker runs, on fakes: SQLite with the D1 migration, the local Ledger (what the wallet's Durable
 * Object hosts), the FixtureChain, no OAuth provider. One build per test.
 */
export const testServices = (fixture: FixtureChain = makeFixtureChain(), counter?: Counter['Service']) => {
  const db = Layer.unwrap(Effect.promise(async () => Db.fromEngine(await sqliteEngine())))
  const ledger = Layer.effect(Ledger, makeLocalLedger)
  return Layer.mergeAll(
    testSettings,
    testWalletSettings,
    Layer.succeed(Chain, fixture.chain),
    OAuthGrants.none,
    Layer.succeed(Counter, counter ?? { read: Effect.die('no counter in this test') }),
    ledger,
  ).pipe(Layer.provideMerge(db))
}
