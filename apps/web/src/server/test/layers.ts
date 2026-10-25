import { Effect, Layer, Option } from 'effect'

import { Chain, type FixtureChain, makeFixtureChain, USDC_SAC } from '@hm/protocol'

import { Counter } from '../counter.ts'
import { Db } from '../db.ts'
import { Ledger, makeLocalLedger } from '../ledger.ts'
import { Network, type NetworkShape } from '../network.ts'
import { OAuthGrants } from '../oauth-grants.ts'
import { Settings } from '../settings.ts'
import { DEFAULT_CREATE_LIMITS, WalletCaps, type WalletCapsShape, memoryWalletCaps } from '../wallet-caps.ts'
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
  demoContacts: [],
})

export const testNetwork: NetworkShape = {
  name: 'testnet',
  caip: 'stellar:testnet',
  label: 'Testnet',
  explorerBase: 'https://stellar.expert/explorer/testnet',
  usdcSac: USDC_SAC,
  caps: {
    maxGrantStroops: 200_000_000n,
    maxOwnerPaymentStroops: 1_000_000_000n,
    maxX402PriceStroops: 10_000_000n,
    paymentsEnabled: true,
  },
  fees: { firstXlm: 35, laterXlm: 4, ownerXlm: 1 },
  rentFactor: Effect.succeed(null),
  welcomeFunding: true,
  inviteRequired: false,
  inviteCodes: [],
}

/**
 * Every service the Worker runs, on fakes: SQLite with the D1 migration, the local Ledger (what the wallet's Durable
 * Object hosts), the FixtureChain, no OAuth provider. One build per test.
 */
export const testServices = (
  fixture: FixtureChain = makeFixtureChain(),
  counter?: Counter['Service'],
  network: NetworkShape = testNetwork,
  caps: WalletCapsShape = memoryWalletCaps(DEFAULT_CREATE_LIMITS),
) => {
  const db = Layer.unwrap(Effect.promise(async () => Db.fromEngine(await sqliteEngine())))
  const ledger = Layer.effect(Ledger, makeLocalLedger)
  return Layer.mergeAll(
    testSettings,
    testWalletSettings,
    Layer.succeed(Chain, fixture.chain),
    OAuthGrants.none,
    Layer.succeed(Network, network),
    Layer.succeed(WalletCaps, caps),
    Layer.succeed(Counter, counter ?? { read: Effect.die('no counter in this test') }),
    ledger,
  ).pipe(Layer.provideMerge(db))
}
