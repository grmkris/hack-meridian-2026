import { Schema } from 'effect'

import { Stroops } from './money.ts'

/**
 * The eight entities of docs/SPEC.md "Data model", as the service stores them (D1 rows decode into these). Amounts are
 * stroops (7-dp integers, `bigint` in memory, decimal strings on the wire); times are ISO-8601 UTC strings.
 */

export const Network = Schema.Literals(['stellar:testnet', 'stellar:pubnet'])
export type Network = typeof Network.Type

export const Asset = Schema.Literal('USDC')
export type Asset = typeof Asset.Type

/** Circle's testnet USDC Stellar Asset Contract (7 decimals) and its classic issuer. */
export const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

/** strkeys: `C…` contract, `G…` classic account, `M…` muxed account. */
export const ContractAddress = Schema.String.check(Schema.isPattern(/^C[A-Z2-7]{55}$/u))
export const AccountAddress = Schema.String.check(Schema.isPattern(/^G[A-Z2-7]{55}$/u))
export const MuxedAddress = Schema.String.check(Schema.isPattern(/^M[A-Z2-7]{68}$/u))
export const StellarAddress = Schema.String.check(Schema.isPattern(/^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u))
export type StellarAddress = typeof StellarAddress.Type

export const IsoTime = Schema.String
export type IsoTime = typeof IsoTime.Type

export const Wallet = Schema.Struct({
  id: Schema.String,
  owner_id: Schema.String,
  name: Schema.String,
  /** The OpenZeppelin smart account (`C…`). */
  contract_id: ContractAddress,
  /** WebAuthn credential id, base64url. */
  passkey_credential_id: Schema.String,
  /** 65-byte uncompressed P-256 public key, base64url. */
  passkey_public_key: Schema.String,
  network: Network,
  created_at: IsoTime,
})
export type Wallet = typeof Wallet.Type

export const ConnectionStatus = Schema.Literals(['active', 'revoked'])
export type ConnectionStatus = typeof ConnectionStatus.Type

export const Connection = Schema.Struct({
  id: Schema.String,
  owner_id: Schema.String,
  wallet_id: Schema.String,
  /** The OAuth client id. Shown and logged, never a key: CIMD ids are shared by every user of that client. */
  oauth_client_id: Schema.String,
  oauth_client_name: Schema.String,
  /** For a CIMD client, the domain that publishes its metadata ("Published by …"). */
  oauth_client_domain: Schema.NullOr(Schema.String),
  /** The workers-oauth-provider grant id, for revokeGrant. */
  oauth_grant_id: Schema.String,
  status: ConnectionStatus,
  created_at: IsoTime,
  revoked_at: Schema.NullOr(IsoTime),
})
export type Connection = typeof Connection.Type

export const GrantStatus = Schema.Literals(['active', 'revoked', 'expired'])
export type GrantStatus = typeof GrantStatus.Type

/** Onchain state of the grant's context rule. */
export const RuleStatus = Schema.Literals(['installed', 'removal_pending', 'removed'])
export type RuleStatus = typeof RuleStatus.Type

export const SpendingGrant = Schema.Struct({
  id: Schema.String,
  connection_id: Schema.String,
  wallet_id: Schema.String,
  /** The connection key K: Ed25519 public key as a `G…` strkey; also the pocket's address. */
  signer_public_key: AccountAddress,
  /** Opaque ref the chain package resolves to K's encrypted secret. Never the secret itself. */
  signer_key_ref: Schema.String,
  asset: Asset,
  total: Stroops,
  spent: Stroops,
  reserved: Stroops,
  valid_until: IsoTime,
  valid_until_ledger: Schema.Int,
  /** ContextRule.id returned by add_context_rule. Ids are monotonic and never reused. */
  rule_id: Schema.Int,
  rule_status: RuleStatus,
  /** G(K): the pocket the x402 lane pays from (sponsored reserves + USDC trustline). */
  pocket_address: Schema.NullOr(AccountAddress),
  /** USDC in the pocket: pulled under the rule (so already counted in `spent`) and not yet paid to a seller. */
  pocket_balance: Stroops,
  /** The first delegated payment under a rule extends its rent (up to ~17 XLM); later ones cost ~1.5 XLM. */
  first_payment_done: Schema.Boolean,
  status: GrantStatus,
  install_tx: Schema.String,
  created_at: IsoTime,
})
export type SpendingGrant = typeof SpendingGrant.Type

export const Readiness = Schema.Literals(['usdc_ready', 'trustline_required', 'account_missing', 'unverified'])
export type Readiness = typeof Readiness.Type

export const Destination = Schema.Struct({
  address: StellarAddress,
  network: Network,
  memo: Schema.NullOr(Schema.String),
  readiness: Readiness,
  verified_at: Schema.NullOr(IsoTime),
  last_paid_at: Schema.NullOr(IsoTime),
})
export type Destination = typeof Destination.Type

export const Contact = Schema.Struct({
  id: Schema.String,
  owner_id: Schema.String,
  display_name: Schema.String,
  aliases: Schema.Array(Schema.String),
  destinations: Schema.Array(Destination),
  created_at: IsoTime,
})
export type Contact = typeof Contact.Type

export const Lane = Schema.Literals(['autonomous', 'owner'])
export type Lane = typeof Lane.Type

/**
 * prepared → (autonomous) reserved → submitted → confirmed | failed;
 * prepared → (owner) awaiting_approval → approved → submitted → confirmed | failed;
 * any state before submission → expired.
 */
export const IntentStatus = Schema.Literals([
  'prepared',
  'reserved',
  'awaiting_approval',
  'approved',
  'submitted',
  'confirmed',
  'failed',
  'expired',
])
export type IntentStatus = typeof IntentStatus.Type

/** What the intent pays for: a person, an x402 resource, an x402-paid MCP tool. */
export const IntentKind = Schema.Literals(['payment', 'x402_fetch', 'x402_mcp'])
export type IntentKind = typeof IntentKind.Type

export const PaymentIntent = Schema.Struct({
  id: Schema.String,
  idempotency_key: Schema.String,
  kind: IntentKind,
  wallet_id: Schema.String,
  connection_id: Schema.NullOr(Schema.String),
  grant_id: Schema.NullOr(Schema.String),
  /** Who asked: the connection's client name, or "owner". */
  requester: Schema.String,
  /** The agent's free-text reason, shown to the owner as the agent's claim. */
  reason: Schema.NullOr(Schema.String),
  contact_id: Schema.NullOr(Schema.String),
  recipient_name: Schema.NullOr(Schema.String),
  recipient_address: StellarAddress,
  recipient_readiness: Readiness,
  /** x402 resource URL or MCP server URL + tool. */
  resource: Schema.NullOr(Schema.String),
  asset: Asset,
  network: Network,
  amount: Stroops,
  fee_ceiling_xlm: Schema.Finite,
  lane: Lane,
  status: IntentStatus,
  failure: Schema.NullOr(Schema.String),
  expires_at: IsoTime,
  created_at: IsoTime,
  updated_at: IsoTime,
})
export type PaymentIntent = typeof PaymentIntent.Type

export const ReservationState = Schema.Literals(['held', 'consumed', 'released'])
export type ReservationState = typeof ReservationState.Type

export const PaymentReservation = Schema.Struct({
  intent_id: Schema.String,
  grant_id: Schema.String,
  amount: Stroops,
  state: ReservationState,
  created_at: IsoTime,
  updated_at: IsoTime,
})
export type PaymentReservation = typeof PaymentReservation.Type

export const OperationStatus = Schema.Literals(['prepared', 'submitted', 'confirmed', 'failed', 'unknown'])
export type OperationStatus = typeof OperationStatus.Type

/** What an operation did: a direct transfer, a pull into the pocket, an x402 settlement, a sweep, a rule change. */
export const OperationKind = Schema.Literals([
  'transfer',
  'owner_transfer',
  'pocket_pull',
  'x402_settlement',
  'pocket_sweep',
  'rule_install',
  'rule_remove',
  'claim',
])
export type OperationKind = typeof OperationKind.Type

export const Operation = Schema.Struct({
  id: Schema.String,
  intent_id: Schema.NullOr(Schema.String),
  kind: OperationKind,
  tx_hash: Schema.NullOr(Schema.String),
  submitted_at: Schema.NullOr(IsoTime),
  ledger: Schema.NullOr(Schema.Int),
  status: OperationStatus,
  /** JSON of the chain result or error; never contains a secret. */
  raw_result: Schema.NullOr(Schema.String),
})
export type Operation = typeof Operation.Type

export const ReceiptRecord = Schema.Struct({
  id: Schema.String,
  operation_id: Schema.String,
  intent_id: Schema.String,
  wallet_id: Schema.String,
  connection_id: Schema.NullOr(Schema.String),
  kind: IntentKind,
  amount: Stroops,
  asset: Asset,
  fee_stroops: Stroops,
  /** The relayer pays every smart-account fee; a facilitator pays the x402 settlement fee. */
  fee_paid_by: Schema.Literals(['relayer', 'facilitator']),
  fee_payer: Schema.String,
  recipient_name: Schema.NullOr(Schema.String),
  recipient_address: StellarAddress,
  tx_hash: Schema.String,
  ledger: Schema.Int,
  confirmed_at: IsoTime,
  explorer_url: Schema.String,
  /** x402: the pocket pull before the settlement (null when the pocket already held enough). */
  pull_tx_hash: Schema.NullOr(Schema.String),
  pull_explorer_url: Schema.NullOr(Schema.String),
  requester: Schema.String,
  lane: Lane,
  resource: Schema.NullOr(Schema.String),
})
export type ReceiptRecord = typeof ReceiptRecord.Type
