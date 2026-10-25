import { Context, type Effect, Schema } from 'effect'

import { Stroops } from './money.ts'

/**
 * The boundary between the wallet service (A1, apps/web/src/server) and Stellar (A2, packages/stellar). It follows the
 * `Chain` interface in docs/BUILD-PLAN.md, as Effects with a typed error instead of Promises, plus the prepare steps
 * the owner's passkey needs (it signs a challenge the server computed from an unsigned auth entry, then the server
 * finalizes). Every value that crosses a request boundary (stored between a page GET and its POST) is plain JSON.
 *
 * Secrets never cross this boundary: a `signerKeyRef` is an opaque string the chain package resolves to an encrypted
 * Ed25519 secret; the relayer, treasury and demo-recipient keys are Worker secrets the chain package reads itself.
 */

/** A confirmed transaction (getTransaction SUCCESS). Never returned for a submitted-but-unconfirmed one. */
export const Receipt = Schema.Struct({
  tx: Schema.String,
  ledger: Schema.Int,
  feeStroops: Stroops,
  /** Who paid the fee: the relayer `G…` for smart-account transactions, the facilitator for x402 settlements. */
  feePayer: Schema.String,
  explorer: Schema.String,
})
export type Receipt = typeof Receipt.Type

/** What `navigator.credentials.get()` returns, as raw bytes (signature DER-encoded, exactly as the browser gives it). */
export interface WebAuthnAssertion {
  readonly authenticatorData: Uint8Array
  readonly clientDataJSON: Uint8Array
  readonly signature: Uint8Array
}

/** The same assertion as the browser POSTs it: base64url fields. */
export const WebAuthnAssertionJson = Schema.Struct({
  authenticatorData: Schema.Uint8ArrayFromBase64Url,
  clientDataJSON: Schema.Uint8ArrayFromBase64Url,
  signature: Schema.Uint8ArrayFromBase64Url,
})

/** The owner's passkey: the account's admin signer `External(WEBAUTHN_VERIFIER, pubkey ‖ credentialId)`. */
export interface OwnerPasskey {
  /** 65-byte uncompressed P-256 public key. */
  readonly pubkey: Uint8Array
  readonly credentialId: Uint8Array
}

/**
 * An invocation that needs the owner's passkey, between prepare and finalize. The page runs
 * `navigator.credentials.get({ publicKey: { challenge: base64url-decode(challenge), … } })`; the server passes the
 * assertion back with this object to the matching finalize call.
 */
export const PreparedOwnerAuth = Schema.Struct({
  kind: Schema.Literals(['install_grant', 'remove_grant', 'owner_transfer', 'claim_sender']),
  contractId: Schema.String,
  /** base64url of `webAuthnChallenge(entry, ruleIds, validUntilLedger).digest`. */
  challenge: Schema.String,
  /** The auth entry's signature expiration ledger. */
  validUntilLedger: Schema.Int,
  /** The unsigned auth entry (base64 XDR). */
  entryXdr: Schema.String,
  /** Chain-package state needed to finalize (host function XDR, rule ids, grant parameters…), JSON. Opaque here. */
  payload: Schema.String,
})
export type PreparedOwnerAuth = typeof PreparedOwnerAuth.Type

/** A CAP-73 claim: the recipient signs `trust`, the sender's `transfer` rides in the same router invocation. */
export const PreparedClaim = Schema.Struct({
  sender: Schema.String,
  recipient: Schema.String,
  amountStroops: Stroops,
  validUntilLedger: Schema.Int,
  /** The recipient's unsigned `trust` auth entry (base64 XDR); a browser wallet signs it with signAuthEntry. */
  recipientEntryXdr: Schema.String,
  /** The sender (smart account) entry (base64 XDR). */
  senderEntryXdr: Schema.String,
  /** base64url challenge over the sender entry, for the owner's passkey. */
  senderChallenge: Schema.String,
  payload: Schema.String,
})
export type PreparedClaim = typeof PreparedClaim.Type

/** How the sender side of a claim is authorized: the owner's passkey, or the connection key under its rule. */
export type ClaimSenderAuth =
  | { readonly _tag: 'Owner'; readonly assertion: WebAuthnAssertion }
  | { readonly _tag: 'Delegated'; readonly ruleId: number; readonly signerKeyRef: string }

/** The terms a seller asked for in its 402 (`PAYMENT-REQUIRED`), as the chain package read them. */
export const X402Quote = Schema.Struct({
  scheme: Schema.String,
  /** CAIP-2, e.g. `stellar:testnet`. */
  network: Schema.String,
  /** The token contract (`C…`), e.g. the USDC SAC. */
  asset: Schema.String,
  amountStroops: Stroops,
  payTo: Schema.String,
  resource: Schema.String,
  maxTimeoutSeconds: Schema.Int,
})
export type X402Quote = typeof X402Quote.Type

export type ChainReadiness = 'usdc_ready' | 'trustline_required' | 'account_missing' | 'contract'

/** Everything that can go wrong on the chain side, by the codes S1 mapped. */
export const ChainErrorKind = Schema.Literals([
  /** `#3221`: the spending-limit policy refused (allowance used up) → owner lane. */
  'limit_exhausted',
  /** `#3002`: the rule expired (or the wrong rule id). */
  'expired',
  /** `#3000`: the rule was removed. */
  'removed',
  /** `#3223`: not a `transfer` call. */
  'not_transfer',
  /** SAC `#10`: the payer holds too little. */
  'insufficient_balance',
  'simulation_failed',
  'submit_failed',
  /** The service's quote hook declined an x402 payment (it does not fit the grant): nothing was signed. */
  'declined',
  'unknown',
])
export type ChainErrorKind = typeof ChainErrorKind.Type

export class ChainError extends Schema.TaggedError<ChainError>()('ChainError', {
  kind: ChainErrorKind,
  message: Schema.String,
  /** The transaction hash when one was submitted (submit_failed after send, unknown after a timeout). */
  tx: Schema.optional(Schema.String),
}) {}

/** Map a Soroban contract error code (`Error(Contract, #n)`) to a kind. */
export const chainErrorKindFromCode = (code: number): ChainErrorKind =>
  code === 3221
    ? 'limit_exhausted'
    : code === 3002
      ? 'expired'
      : code === 3000
        ? 'removed'
        : code === 3223
          ? 'not_transfer'
          : code === 10
            ? 'insufficient_balance'
            : 'simulation_failed'

/** The relayer pool and fee conditions, for /api/health and the demo probe. */
export interface ChainHealth {
  readonly network: string
  readonly latestLedger: number
  readonly relayers: ReadonlyArray<{ readonly address: string; readonly xlmStroops: bigint }>
  readonly treasury: { readonly address: string; readonly usdcStroops: bigint; readonly xlmStroops: bigint } | null
  /** Testnet rent relative to normal (≈ 47 on 2026-10-25); null when unknown. */
  readonly rentFactor: number | null
  /** The shared contracts (verifiers, policy, USDC) and when their instance/code entries expire. */
  readonly contracts?: ReadonlyArray<{
    readonly name: string
    readonly id: string
    readonly liveUntilLedger: number | null
    readonly ledgersLeft: number | null
  }>
}

/** The quote hook: called with the seller's terms before anything is signed. Fail with `declined` to stop. */
export type X402QuoteHook = (quote: X402Quote) => Effect.Effect<void, ChainError>

export interface ChainShape {
  /** Relayer deploys the smart account with the passkey as rule 0. */
  readonly deployAccount: (ownerPasskey: OwnerPasskey) => Effect.Effect<{ contractId: string; tx: string }, ChainError>
  /** Treasury → wallet, testnet only (the judge path: 10 USDC on create). */
  readonly fundNewWallet: (contractId: string, usdc: bigint) => Effect.Effect<{ tx: string }, ChainError>
  /** A fresh connection key K, encrypted under the vault key. `address` is K as a `G…` strkey. */
  readonly newSigner: Effect.Effect<{ signerKeyRef: string; publicKey: Uint8Array; address: string }, ChainError>
  /** Builds `add_context_rule(CallContract(USDC), [External(ED25519, K)], SPENDING_LIMIT{L + 720, N}, latest + L)`. */
  readonly prepareInstallGrant: (
    contractId: string,
    signerPub: Uint8Array,
    limitStroops: bigint,
    lifetimeSeconds: number,
  ) => Effect.Effect<PreparedOwnerAuth, ChainError>
  readonly installGrant: (
    prepared: PreparedOwnerAuth,
    ownerAssertion: WebAuthnAssertion,
  ) => Effect.Effect<{ ruleId: number; validUntilLedger: number; tx: string }, ChainError>
  readonly prepareRemoveGrant: (contractId: string, ruleId: number) => Effect.Effect<PreparedOwnerAuth, ChainError>
  readonly removeGrant: (
    prepared: PreparedOwnerAuth,
    ownerAssertion: WebAuthnAssertion,
  ) => Effect.Effect<{ tx: string }, ChainError>
  readonly readGrant: (
    contractId: string,
    ruleId: number,
  ) => Effect.Effect<{ spent: bigint; limit: bigint; validUntilLedger: number; live: boolean }, ChainError>
  readonly prepareOwnerTransfer: (
    contractId: string,
    to: string,
    amountStroops: bigint,
    validForLedgers: number,
  ) => Effect.Effect<PreparedOwnerAuth, ChainError>
  readonly finalizeOwnerTransfer: (
    prepared: PreparedOwnerAuth,
    assertion: WebAuthnAssertion,
  ) => Effect.Effect<Receipt, ChainError>
  /** People payments and pocket pulls: K signs under its rule; enforce-simulation first, so over-limit never submits. */
  readonly delegatedTransfer: (
    contractId: string,
    ruleId: number,
    signerKeyRef: string,
    to: string,
    amountStroops: bigint,
  ) => Effect.Effect<Receipt, ChainError>
  /** G(K) with sponsored reserves and a USDC trustline. */
  readonly createPocket: (signerKeyRef: string) => Effect.Effect<{ address: string; tx: string }, ChainError>
  readonly sweepPocket: (signerKeyRef: string, toContractId: string) => Effect.Effect<Receipt, ChainError>
  /**
   * GET `url`; on 402 call `onQuote` (the service validates, reserves and pulls the shortfall into the pocket there),
   * then pay from the pocket through the facilitator with `payment-identifier = paymentId`. `settlement` is null when
   * the resource answered without a 402.
   */
  readonly payX402: (
    signerKeyRef: string,
    url: string,
    maxAmountStroops: bigint,
    paymentId: string,
    onQuote: X402QuoteHook,
  ) => Effect.Effect<{ body: Response; settlement: Receipt | null; quote: X402Quote | null }, ChainError>
  readonly payX402Mcp: (
    signerKeyRef: string,
    mcpUrl: string,
    tool: string,
    args: unknown,
    maxAmountStroops: bigint,
    paymentId: string,
    onQuote: X402QuoteHook,
  ) => Effect.Effect<{ result: unknown; settlement: Receipt | null; quote: X402Quote | null }, ChainError>
  /** Pocket balance, so a pull takes only the shortfall. */
  readonly balances: (address: string) => Effect.Effect<{ usdc: bigint; xlm: bigint }, ChainError>
  readonly readiness: (address: string) => Effect.Effect<ChainReadiness, ChainError>
  readonly prepareClaim: (
    sender: string,
    recipient: string,
    amountStroops: bigint,
    validForLedgers: number,
  ) => Effect.Effect<PreparedClaim, ChainError>
  /** Testnet demo only: the seeded demo recipient's key (a chain-package secret) signs the `trust` entry. */
  readonly signClaimAsDemoRecipient: (prepared: PreparedClaim) => Effect.Effect<string, ChainError>
  readonly finalizeClaim: (
    prepared: PreparedClaim,
    recipientSignedEntryXdr: string,
    sender: ClaimSenderAuth,
  ) => Effect.Effect<Receipt, ChainError>
  readonly health: Effect.Effect<ChainHealth, ChainError>
}

export class Chain extends Context.Service<Chain, ChainShape>()('hm/Chain') {}
