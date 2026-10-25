import { Schema } from 'effect'

import { Asset, IntentStatus, IsoTime, Lane, Network, Readiness } from './entities.ts'
import { DecimalAmount } from './money.ts'

/**
 * The ten MCP tools of docs/SPEC.md, as the agent sees them: JSON in, JSON out, amounts as decimal strings. Every
 * call carries an idempotency key (required on writes); every result carries `grant_remaining` (policy remaining plus
 * the pocket balance).
 */

const IdempotencyKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
  description: 'A key unique to this request; repeating it returns the same result and never pays twice',
})
const OptionalKey = Schema.optionalKey(IdempotencyKey)
const Reason = Schema.String.check(Schema.isMaxLength(280)).annotate({
  description: "Why the agent is paying; the owner sees it marked as the agent's claim",
})

/** The connection's spending grant as the agent sees it. */
export const GrantView = Schema.Struct({
  grant_id: Schema.String,
  asset: Asset,
  total: Schema.String,
  spent: Schema.String,
  reserved: Schema.String,
  /** USDC already pulled into the connection's pocket, spendable on x402 purchases. */
  pocket_balance: Schema.String,
  /** total − spent − reserved + pocket_balance: what the connection can still spend. */
  remaining: Schema.String,
  valid_until: IsoTime,
  status: Schema.Literals(['active', 'revoked', 'expired']),
  rule_id: Schema.Int,
})
export type GrantView = typeof GrantView.Type

export const ReceiptView = Schema.Struct({
  receipt_id: Schema.String,
  payment_id: Schema.String,
  kind: Schema.Literals(['payment', 'x402_fetch', 'x402_mcp']),
  amount: Schema.String,
  asset: Asset,
  recipient: Schema.String,
  recipient_name: Schema.NullOr(Schema.String),
  lane: Lane,
  tx_hash: Schema.String,
  ledger: Schema.Int,
  confirmed_at: IsoTime,
  explorer_url: Schema.String,
  pull_tx_hash: Schema.NullOr(Schema.String),
  pull_explorer_url: Schema.NullOr(Schema.String),
  fee_xlm: Schema.String,
  fee_paid_by: Schema.Literals(['relayer', 'facilitator']),
  requester: Schema.String,
  resource: Schema.NullOr(Schema.String),
})
export type ReceiptView = typeof ReceiptView.Type

export const PaymentView = Schema.Struct({
  payment_id: Schema.String,
  kind: Schema.Literals(['payment', 'x402_fetch', 'x402_mcp']),
  status: IntentStatus,
  lane: Lane,
  amount: Schema.String,
  asset: Asset,
  network: Network,
  recipient: Schema.Struct({
    name: Schema.NullOr(Schema.String),
    address: Schema.String,
    readiness: Readiness,
  }),
  fee_ceiling_xlm: Schema.Finite,
  reason: Schema.NullOr(Schema.String),
  expires_at: IsoTime,
  approval_url: Schema.NullOr(Schema.String),
  /** For a recipient without a USDC trustline: the link they open to accept (CAP-73 claim). */
  claim_url: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(ReceiptView),
  failure: Schema.NullOr(Schema.String),
  /** What the agent should do next, in one sentence. */
  next_step: Schema.String,
  grant_remaining: Schema.String,
})
export type PaymentView = typeof PaymentView.Type

// 1. wallet_overview
export const WalletOverviewInput = Schema.Struct({ idempotency_key: OptionalKey })
export const WalletOverviewOutput = Schema.Struct({
  wallet: Schema.Struct({ id: Schema.String, name: Schema.String, contract_id: Schema.String, network: Network }),
  balances: Schema.Struct({ usdc: Schema.String, xlm: Schema.String }),
  grant: Schema.NullOr(GrantView),
  pending_approvals: Schema.Array(PaymentView),
  recent_receipts: Schema.Array(ReceiptView),
  connection: Schema.Struct({ id: Schema.String, client_name: Schema.String, status: Schema.String }),
  grant_remaining: Schema.String,
})
export type WalletOverviewOutput = typeof WalletOverviewOutput.Type

// 2. contacts_search
export const ContactReadiness = Schema.Literals([
  'usdc_ready',
  'trustline_required',
  'account_missing',
  'unverified',
  'paid_before',
])
export const ContactsSearchInput = Schema.Struct({
  query: Schema.String.annotate({ description: 'Name, alias or address fragment; empty lists all contacts' }),
  idempotency_key: OptionalKey,
})
export const ContactView = Schema.Struct({
  contact_id: Schema.String,
  name: Schema.String,
  aliases: Schema.Array(Schema.String),
  destinations: Schema.Array(
    Schema.Struct({
      address: Schema.String,
      network: Network,
      memo: Schema.NullOr(Schema.String),
      readiness: Schema.Array(ContactReadiness),
      last_paid_at: Schema.NullOr(IsoTime),
    }),
  ),
})
export type ContactView = typeof ContactView.Type
export const ContactsSearchOutput = Schema.Struct({
  contacts: Schema.Array(ContactView),
  grant_remaining: Schema.String,
})
export type ContactsSearchOutput = typeof ContactsSearchOutput.Type

// 3. payment_prepare
export const PaymentPrepareInput = Schema.Struct({
  recipient: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'A saved contact name or id, or a Stellar address (C…, G…, M…)',
  }),
  amount: DecimalAmount.annotate({ description: 'Decimal amount, e.g. "2" or "0.10" (7 decimals at most)' }),
  asset: Schema.optionalKey(Asset),
  memo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(28))),
  reason: Schema.optionalKey(Reason),
  idempotency_key: IdempotencyKey,
})
export type PaymentPrepareInput = typeof PaymentPrepareInput.Type
export const PaymentPrepareOutput = PaymentView

// 4. payment_execute
export const PaymentExecuteInput = Schema.Struct({ payment_id: Schema.String, idempotency_key: IdempotencyKey })
export type PaymentExecuteInput = typeof PaymentExecuteInput.Type
export const PaymentExecuteOutput = PaymentView

// 5. payment_approve_url
export const PaymentApproveUrlInput = Schema.Struct({ payment_id: Schema.String, idempotency_key: OptionalKey })
export const PaymentApproveUrlOutput = Schema.Struct({
  payment_id: Schema.String,
  status: IntentStatus,
  approval_url: Schema.NullOr(Schema.String),
  expires_at: IsoTime,
  grant_remaining: Schema.String,
})

// 6. payment_status
export const PaymentStatusInput = Schema.Struct({ payment_id: Schema.String, idempotency_key: OptionalKey })
export const PaymentStatusOutput = PaymentView

// 7. paid_resource_fetch
export const PaidResourceFetchInput = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
  max_amount: Schema.optionalKey(DecimalAmount).annotate({
    description: 'Refuse to pay more than this for the resource (default: the grant remaining)',
  }),
  reason: Schema.optionalKey(Reason),
  idempotency_key: IdempotencyKey,
})
export type PaidResourceFetchInput = typeof PaidResourceFetchInput.Type
export const PaidOutcome = Schema.Literals(['paid', 'free', 'requires_approval', 'refused', 'failed'])
export const PaidResourceFetchOutput = Schema.Struct({
  status: PaidOutcome,
  payment_id: Schema.NullOr(Schema.String),
  http_status: Schema.NullOr(Schema.Int),
  content_type: Schema.NullOr(Schema.String),
  /** The response body as text, truncated to 64 KiB. */
  body: Schema.NullOr(Schema.String),
  price: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(ReceiptView),
  approval_url: Schema.NullOr(Schema.String),
  message: Schema.String,
  grant_remaining: Schema.String,
})
export type PaidResourceFetchOutput = typeof PaidResourceFetchOutput.Type

// 8. paid_mcp_call
export const PaidMcpCallInput = Schema.Struct({
  server_url: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
  tool: Schema.String.check(Schema.isMinLength(1)),
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  max_amount: Schema.optionalKey(DecimalAmount),
  reason: Schema.optionalKey(Reason),
  idempotency_key: IdempotencyKey,
})
export type PaidMcpCallInput = typeof PaidMcpCallInput.Type
export const PaidMcpCallOutput = Schema.Struct({
  status: PaidOutcome,
  payment_id: Schema.NullOr(Schema.String),
  result: Schema.Unknown,
  price: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(ReceiptView),
  approval_url: Schema.NullOr(Schema.String),
  message: Schema.String,
  grant_remaining: Schema.String,
})
export type PaidMcpCallOutput = typeof PaidMcpCallOutput.Type

// 9. connection_grant_create
export const ConnectionGrantCreateInput = Schema.Struct({
  amount: Schema.optionalKey(DecimalAmount),
  valid_for_hours: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  idempotency_key: IdempotencyKey,
})
export const ConnectionGrantCreateOutput = Schema.Struct({
  url: Schema.String,
  message: Schema.String,
  grant_remaining: Schema.String,
})

// 10. connection_grant_revoke
export const ConnectionGrantRevokeInput = Schema.Struct({ idempotency_key: IdempotencyKey })
export const ConnectionGrantRevokeOutput = Schema.Struct({
  status: Schema.Literal('revoked'),
  onchain: Schema.Literals(['removed', 'pending_owner']),
  approval_url: Schema.NullOr(Schema.String),
  sweep_tx: Schema.NullOr(Schema.String),
  /** The rule-removal transaction once the owner removed it (stellar.expert link in removal_explorer_url). */
  removal_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.String,
  grant_remaining: Schema.String,
})

export const TOOL_NAMES = [
  'wallet_overview',
  'contacts_search',
  'payment_prepare',
  'payment_execute',
  'payment_approve_url',
  'payment_status',
  'paid_resource_fetch',
  'paid_mcp_call',
  'connection_grant_create',
  'connection_grant_revoke',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]
