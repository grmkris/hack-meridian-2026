import { Layer } from 'effect'

import { StellarLive } from './chain.ts'
import { ChainConfig } from './config.ts'
import { KeyVault } from './vault.ts'

/**
 * `@hm/stellar`: the `Chain` (from `@hm/protocol`) on Stellar testnet, plus the key vault and the pure helpers the
 * approval page and tests need. Everything that signs or holds a secret stays inside this package.
 *
 * In the Worker:
 *
 * ```ts
 * import { stellarLayer } from '@hm/stellar'
 * // provides Chain, StellarOps and KeyVault; reads its settings from the ambient ConfigProvider
 * const ChainLayer = stellarLayer(fetch.bind(globalThis)).pipe(
 *   Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(bindings))),
 * )
 * ```
 */
export const stellarLayer = (fetchImpl: typeof globalThis.fetch) =>
  Layer.merge(StellarLive, KeyVault.layer).pipe(Layer.provide(ChainConfig.fromConfig(fetchImpl)))

export { makeStellar, receiptOf, StellarCore, StellarLive } from './chain.ts'
export { StellarOps } from './ops.ts'
export type { StellarOpsShape, TtlEntry, TtlStatus } from './ops.ts'
export {
  ChainConfig,
  chainSettingsConfig,
  DEFAULT_CAPS,
  DEFAULT_OWNER_AUTH_LEDGERS,
  DEFAULT_WALLET_TTL_LEDGERS,
  networkConfig,
  usdcToStroops,
} from './config.ts'
export type { ChainSettings, SafetyCaps } from './config.ts'
export {
  explorerAccount,
  explorerContract,
  explorerTx,
  missingFields,
  networkName,
  PRESETS,
  PUBNET,
  TESTNET,
  usdcAssetOf,
} from './network.ts'
export type { NetworkContracts, NetworkFees, NetworkName, NetworkParams } from './network.ts'
export { KeyVault } from './vault.ts'
export {
  authDigest,
  authPayloadScVal,
  authorizeWithEd25519,
  authorizeWithSigners,
  authorizeWithWebAuthn,
  ChallengeMismatch,
  compactToDer,
  derToCompactLowS,
  ed25519Signer,
  entryAddress,
  entryRootCall,
  webAuthnChallenge,
  webAuthnSignatureBytes,
  webAuthnSignerScVal,
} from './auth.ts'
export type { SmartSigner } from './auth.ts'
export * from './constants.ts'
export { contractCodes, describeCode, fromOnchainFailure, fromSimulationError, primaryContractCode } from './errors.ts'
export {
  DEFAULT_CHUNK_STROOPS,
  grantRuleName,
  grantWindow,
  ledgersToSeconds,
  PERIOD_MARGIN_LEDGERS,
  pullAmount,
  remainingAt,
  ruleLive,
  spentAt,
} from './grant.ts'
export type { GrantWindow } from './grant.ts'
export { makeInvoker } from './invoke.ts'
export { ownerOneShot } from './owner.ts'
export type { Invoker, PreparedCall } from './invoke.ts'
export { accountOf, readinessFrom } from './readiness.ts'
export { rentFactor, rentWriteFeePer1Kb } from './rent.ts'
export type { RentConfig } from './rent.ts'
export { makeSoroban } from './soroban.ts'
export type { Soroban, TxOutcome } from './soroban.ts'
export { normalizePaymentId, stroopsToUsd } from './x402.ts'
export { parseTransfer, transferAmount, transfersTo, transferToFilter } from './watch.ts'
export type { IncomingTransfer, TransferPage } from './watch.ts'
