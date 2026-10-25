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
  /** Rent the transaction paid (testnet rent runs at ~47–73× normal), when the meta reports it. */
  rentStroops: Schema.optionalKey(Stroops),
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

/**
 * A person link's payment (an allowance for a person, claims.ts): the sender's account pays `to` under the link's own
 * rule, and the link key, which only the recipient's browser holds, signs `digest`. Plain JSON between the page's two
 * POSTs; nothing in it is secret.
 */
export const PreparedLinkTransfer = Schema.Struct({
  contractId: Schema.String,
  ruleId: Schema.Int,
  /** The link key: a 32-byte Ed25519 public key, base64url. */
  signerPublicKey: Schema.String,
  to: Schema.String,
  amountStroops: Stroops,
  /** base64url of the 32-byte auth digest the link key signs (the same digest an AI app's key signs). */
  digest: Schema.String,
  validUntilLedger: Schema.Int,
  /** The sender's unsigned auth entry and the host function (base64 XDR). */
  entryXdr: Schema.String,
  func: Schema.String,
})
export type PreparedLinkTransfer = typeof PreparedLinkTransfer.Type

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
  /** The enforce simulation's fee is above the ceiling: not submitted. */
  'fee_ceiling_exceeded',
  /** PAYMENTS_ENABLED=false: money-moving signatures are refused (revoke and sweep still work). */
  'payments_disabled',
  /** A safety cap (MAX_GRANT_USDC, MAX_OWNER_PAYMENT_USDC, MAX_X402_PRICE_USDC) refused it. */
  'cap_exceeded',
  /** The passkey assertion does not match the prepared challenge or does not verify. */
  'bad_assertion',
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
  /** Testnet rent relative to normal (≈ 47–73 on 2026-10-25); null when unknown. */
  readonly rentFactor: number | null
  /** The x402 facilitators and whether they answered `/supported`. */
  readonly facilitators?: ReadonlyArray<{ readonly url: string; readonly ok: boolean; readonly ms?: number }>
  /** Explorer base for this network, e.g. https://stellar.expert/explorer/testnet. */
  readonly explorerBase?: string
  /** The shared contracts (verifiers, policy, USDC) and when their instance/code entries expire. */
  readonly contracts?: ReadonlyArray<{
    readonly name: string
    readonly id: string
    readonly liveUntilLedger: number | null
    readonly ledgersLeft: number | null
  }>
}

/**
 * A wallet's deposit address (docs/spikes/s8-deposit.md): a sponsored classic `G…` bound by the deposit router to
 * one smart account; whatever USDC arrives there can only be swept into that account, by anyone.
 */
export interface DepositAddress {
  /** The `G…` to pay (any amount, any number of times, no memo). */
  readonly address: string
  /** The smart account every sweep pays. */
  readonly recipient: string
  /** The router's allowance over G ends after this ledger (~180 days); a later deposit needs a fresh address. */
  readonly expirationLedger: number
  /** The ledger the registration landed in (with `expirationLedger`, the allowance's span; ~5 s per ledger). */
  readonly registeredLedger: number
  /** Proof: the sponsored create + trustline, the registration (approve), the lock (master weight 0). */
  readonly txs: { readonly create: string; readonly register: string; readonly lock: string }
  /**
   * G's teardown (remove trustline, merge into the relayer), authorized by G's only signer, a pre-auth hash of it:
   * fee-bump it once G is empty and retired. Bearer: it can close G, nothing else.
   */
  readonly teardownXdr: string
}

/**
 * Deposit-first signup: where a wallet's smart account will live before anything is onchain. The id is the one
 * `createCustomContract(deployer, salt)` yields, so USDC can be sent to it (and swept into it) before the deploy, and
 * only `deployer`, a relayer, can ever deploy there.
 */
export interface AccountPlan {
  readonly contractId: string
  /** The relayer `G…` that deploys (and alone can deploy) at `contractId`. */
  readonly deployer: string
  /** The 32-byte salt, hex. */
  readonly salt: string
}

/**
 * The quote hook: called with the seller's terms before anything is signed. It validates, reserves and pulls the
 * shortfall into the pocket, returning the pull's receipt (null when the pocket already held enough). Fail with
 * `declined` to stop.
 */
export type X402QuoteHook = (quote: X402Quote) => Effect.Effect<Receipt | null | void, ChainError>

export interface ChainShape {
  /** Relayer deploys the smart account with the passkey as rule 0. */
  readonly deployAccount: (ownerPasskey: OwnerPasskey) => Effect.Effect<{ contractId: string; tx: string }, ChainError>
  /** Deposit-first signup: a fresh salt and the contract id the deployer gets for it. Nothing is submitted. */
  readonly planAccount: Effect.Effect<AccountPlan, ChainError>
  /**
   * Deploy a planned account with the passkey as rule 0 (the same WASM and constructor as `deployAccount`). Idempotent:
   * when the account is already there, `tx` is null and nothing is submitted.
   */
  readonly deployPlannedAccount: (
    ownerPasskey: OwnerPasskey,
    plan: AccountPlan,
  ) => Effect.Effect<{ contractId: string; tx: string | null }, ChainError>
  /** Whether this network has a deposit router, so `createDepositAddress` can work (pubnet: not until it is deployed). */
  readonly depositsAvailable: boolean
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
    /** Refuse (fee_ceiling_exceeded) when the enforce simulation's fee is above this. */
    maxFeeStroops?: bigint,
  ) => Effect.Effect<Receipt, ChainError>
  /** G(K) with sponsored reserves and a USDC trustline. */
  readonly createPocket: (signerKeyRef: string) => Effect.Effect<{ address: string; tx: string }, ChainError>
  readonly sweepPocket: (signerKeyRef: string, toContractId: string) => Effect.Effect<Receipt, ChainError>
  /**
   * A fresh deposit address for `contractId`: sponsored G with a USDC trustline, registered with the deposit router
   * (G approves the router), master weight 0 and the teardown as its only signer, key discarded. Fails `declined` when the network has no router.
   */
  readonly createDepositAddress: (contractId: string) => Effect.Effect<DepositAddress, ChainError>
  /**
   * The permissionless sweep: everything the router may take from `depositAddress` goes to `contractId` (refused when
   * the router binds it elsewhere). `null` when there is nothing to sweep; nothing is submitted then.
   */
  readonly sweepDeposit: (
    depositAddress: string,
    contractId: string,
  ) => Effect.Effect<{ readonly amountStroops: bigint; readonly receipt: Receipt } | null, ChainError>
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
  ) => Effect.Effect<
    { body: Response; settlement: Receipt | null; quote: X402Quote | null; pull?: Receipt | null },
    ChainError
  >
  readonly payX402Mcp: (
    signerKeyRef: string,
    mcpUrl: string,
    tool: string,
    args: unknown,
    maxAmountStroops: bigint,
    paymentId: string,
    onQuote: X402QuoteHook,
  ) => Effect.Effect<
    { result: unknown; settlement: Receipt | null; quote: X402Quote | null; pull?: Receipt | null },
    ChainError
  >
  /**
   * A person link: `USDC.transfer(contractId → to, amount)` under rule `ruleId`, prepared for the link key (an Ed25519
   * public key the sender's browser made; Nod never has the secret). Nothing is signed or submitted.
   */
  readonly prepareLinkTransfer: (
    contractId: string,
    ruleId: number,
    signerPublicKey: Uint8Array,
    to: string,
    amountStroops: bigint,
  ) => Effect.Effect<PreparedLinkTransfer, ChainError>
  /**
   * The link key's 64-byte signature over the prepared digest: checked here, put in the entry, enforce-simulated (the
   * rule's spending limit refuses anything past the amount) and relayed; the relayer pays the fee.
   */
  readonly finalizeLinkTransfer: (
    prepared: PreparedLinkTransfer,
    signature: Uint8Array,
    maxFeeStroops?: bigint,
  ) => Effect.Effect<Receipt, ChainError>
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
