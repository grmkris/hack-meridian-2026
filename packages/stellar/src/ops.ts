import { Context, type Effect } from 'effect'

import type { ChainError, Receipt } from '@hm/protocol'

import type { SafetyCaps } from './config.ts'
import type { NetworkParams } from './network.ts'

/**
 * Operations the wallet service and the demo probe need beyond `Chain` (spike S5 follow-ups): closing a pocket,
 * reading and extending contract TTLs, and the live rent factor. Same relayer pool and keys as `Chain`.
 */
export interface TtlEntry {
  /** `C…` contract id (its instance entry) or a 64-hex WASM hash (its code entry). */
  readonly target: string
  readonly kind: 'instance' | 'code'
  /** Ledger through which the entry is live; null when the entry is missing or archived. */
  readonly liveUntilLedger: number | null
  /** Approximate wall time of `liveUntilLedger` (5 s ledgers from now), ISO 8601 UTC. */
  readonly expiresAtApprox: string | null
}

export interface TtlStatus {
  readonly latestLedger: number
  readonly entries: ReadonlyArray<TtlEntry>
}

export interface StellarOpsShape {
  /** Drop G(K)'s USDC trustline and merge it into a relayer (sponsored reserves return). Its USDC must be 0. */
  readonly closePocket: (signerKeyRef: string) => Effect.Effect<Receipt, ChainError>
  /**
   * Retire a deposit address: G's pre-signed teardown (trustline removed, merged into the relayer that sponsored it),
   * fee-bumped by a relayer. Refuses while G holds USDC (the teardown would fail and burn its only sequence number).
   */
  readonly closeDeposit: (depositAddress: string, teardownXdr: string) => Effect.Effect<Receipt, ChainError>
  /** Instance TTL of each contract (and of its WASM code), and code TTL of each WASM hash. */
  readonly ttlStatus: (
    contractIds: ReadonlyArray<string>,
    wasmHashes: ReadonlyArray<string>,
  ) => Effect.Effect<TtlStatus, ChainError>
  /**
   * `ExtendFootprintTTL` so `target` lives at least `ledgers` more ledgers: a `C…` extends its instance, a 64-hex
   * hash extends that WASM code. The relayer pays the rent; `maxFeeStroops` overrides the configured ceiling.
   */
  readonly extendTtl: (target: string, ledgers: number, maxFeeStroops?: bigint) => Effect.Effect<Receipt, ChainError>
  /** Testnet rent relative to the at-target rate, read live from the network config (null when unreadable). */
  readonly rentFactor: Effect.Effect<number | null, ChainError>
  /** The network in use: name, explorer base (build links from it), contract ids, suggested fee ceilings. */
  readonly network: NetworkParams
  /** MAX_GRANT_USDC, MAX_OWNER_PAYMENT_USDC, MAX_X402_PRICE_USDC and PAYMENTS_ENABLED as configured. */
  readonly caps: SafetyCaps
}

export class StellarOps extends Context.Service<StellarOps, StellarOpsShape>()('hm/stellar/StellarOps') {}
