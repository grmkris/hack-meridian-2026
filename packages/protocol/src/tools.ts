import { Schema } from 'effect'

import { ApprovalReason, Asset, IntentStatus, IsoTime, Lane, Network, Readiness } from './entities.ts'
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
  /** The nod line, decimal USDC: inside the allowance, a payment at or above it needs the user's nod. */
  nod_above_usdc: Schema.optionalKey(Schema.String),
  status: Schema.Literals(['active', 'revoked', 'expired']),
  rule_id: Schema.Int,
  /** The transaction that installed the allowance on the smart account (and, after a revoke, removed it). */
  install_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  remove_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  /** Why it needs the user's nod (owner lane only), e.g. `above_nod_line` or `over_allowance`. */
  approval_reason: Schema.optionalKey(Schema.NullOr(ApprovalReason)),
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
  wallet: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    contract_id: Schema.String,
    network: Network,
    /** The relayer's deploy transaction and the welcome funding (testnet), when known. */
    deploy_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
    fund_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  balances: Schema.Struct({ usdc: Schema.String, xlm: Schema.String }),
  grant: Schema.NullOr(GrantView),
  pending_approvals: Schema.Array(PaymentView),
  recent_receipts: Schema.Array(ReceiptView),
  connection: Schema.Struct({ id: Schema.String, client_name: Schema.String, status: Schema.String }),
  grant_remaining: Schema.String,
  /** The wallet holds less than this AI app may still spend: offer a top-up (wallet_topup_quote). */
  low_balance: Schema.optionalKey(Schema.Boolean),
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
  /** The AI app that saved this contact; null when the user did. Its first payment needs the user's nod. */
  added_by: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  recipient_name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))).annotate({
    description:
      'With recipient "new": the name of someone without a saved contact or a Stellar address. Nod returns a claim_url to send them; when they open it they choose where the money goes (a new Nod wallet, their Nod wallet or a Stellar address), and it pays then from the allowance, or with the user\'s nod past it. Unclaimed, it pays nothing and expires.',
  }),
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

/** A pull into the pocket that happened even though the purchase did not settle: money moved, accounted for here. */
export const PocketPull = Schema.Struct({
  tx_hash: Schema.String,
  explorer_url: Schema.String,
  amount: Schema.String,
})
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
  /** With `requires_approval`: why it needs the user's nod. */
  approval_reason: Schema.optionalKey(Schema.NullOr(ApprovalReason)),
  message: Schema.String,
  /** Set when a pull happened but the purchase failed; the USDC stays in the pocket for the next purchase. */
  pull: Schema.optionalKey(Schema.NullOr(PocketPull)),
  /** What the seller or facilitator said when it refused. */
  facilitator_message: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  approval_reason: Schema.optionalKey(Schema.NullOr(ApprovalReason)),
  message: Schema.String,
  pull: Schema.optionalKey(Schema.NullOr(PocketPull)),
  facilitator_message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  grant_remaining: Schema.String,
})
export type PaidMcpCallOutput = typeof PaidMcpCallOutput.Type

// 9. connection_grant_create
export const ConnectionGrantCreateInput = Schema.Struct({
  amount: Schema.optionalKey(DecimalAmount),
  valid_for_hours: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  nod_above_usdc: Schema.optionalKey(DecimalAmount).annotate({
    description:
      "The nod line to suggest: payments at or above it need the user's nod (default 1.00, at most the allowance)",
  }),
  idempotency_key: IdempotencyKey,
})
export const ConnectionGrantCreateOutput = Schema.Struct({
  url: Schema.String,
  /** The current allowance and the transaction that installed it. */
  grant: Schema.optionalKey(Schema.NullOr(GrantView)),
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

// 11. nod_home: the wallet as the card's fullscreen Home view (hosts launch it; the model never calls it)
export const NodHomeInput = Schema.Struct({})
export const NodHomeOutput = WalletOverviewOutput

// 16–18. contact_add / contact_update / contact_remove: the user's contacts, changed by an AI app (marked as its)
const ContactName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))
const ContactAddress = Schema.String.check(Schema.isPattern(/^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u)).annotate({
  description: 'A Stellar address: C… (a smart account, e.g. a Nod wallet), G… or M…',
})
const Aliases = Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))).check(
  Schema.isMaxLength(5),
)
const ContactRef = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: 'The contact: its name, an alias, or its contact_id',
})
export const ContactAddInput = Schema.Struct({
  name: ContactName,
  address: ContactAddress,
  aliases: Schema.optionalKey(Aliases),
  idempotency_key: IdempotencyKey,
})
export type ContactAddInput = typeof ContactAddInput.Type
export const ContactChangeOutput = Schema.Struct({
  contact: Schema.NullOr(ContactView),
  /** added, updated, removed, or unchanged (the address was already saved, or the same key repeated). */
  result: Schema.Literals(['added', 'updated', 'removed', 'unchanged']),
  message: Schema.String,
  grant_remaining: Schema.String,
})
export const ContactUpdateInput = Schema.Struct({
  contact: ContactRef,
  name: Schema.optionalKey(ContactName),
  address: Schema.optionalKey(ContactAddress),
  aliases: Schema.optionalKey(Aliases),
  idempotency_key: IdempotencyKey,
})
export type ContactUpdateInput = typeof ContactUpdateInput.Type
export const ContactRemoveInput = Schema.Struct({ contact: ContactRef, idempotency_key: IdempotencyKey })
export type ContactRemoveInput = typeof ContactRemoveInput.Type

// 19. wallet_deposit_address: a G… any exchange or wallet can pay USDC to; it lands in the Nod wallet
export const WalletDepositAddressInput = Schema.Struct({ idempotency_key: OptionalKey })
export const WalletDepositAddressOutput = Schema.Struct({
  /** active: pay it; unavailable: this network has no deposit router yet (send to the wallet's C… from Freighter). */
  status: Schema.Literals(['active', 'unavailable']),
  address: Schema.NullOr(Schema.String),
  network: Network,
  /** After this the address stops working (the router's allowance, ~180 days); a new one replaces it before then. */
  expires_at: Schema.NullOr(IsoTime),
  /** USDC on the address not yet in the wallet (it is swept within a minute while the address is watched). */
  pending: Schema.NullOr(Schema.String),
  received_total: Schema.String,
  wallet_contract_id: Schema.String,
  /** awaiting_deposit: the wallet's account deploys when its first USDC arrives. */
  account_status: Schema.Literals(['awaiting_deposit', 'active']),
  message: Schema.String,
  grant_remaining: Schema.String,
})

// 20. payments_list: newest first, bounded
export const PaymentsListInput = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ).annotate({ description: 'How many, newest first (default 20, at most 50)' }),
  all_apps: Schema.optionalKey(Schema.Boolean).annotate({
    description: "true: every payment of the wallet (the user's own and other AI apps'); default: this AI app's",
  }),
  idempotency_key: OptionalKey,
})
export const PaymentsListOutput = Schema.Struct({
  payments: Schema.Array(PaymentView),
  grant_remaining: Schema.String,
})

// 21. connection_grant_update: a new allowance or expiry, as a link the user's passkey signs
export const ConnectionGrantUpdateInput = Schema.Struct({
  amount: Schema.optionalKey(DecimalAmount).annotate({
    description: 'The new allowance in USDC (default: the current one)',
  }),
  valid_for_hours: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(720)),
  ).annotate({
    description: 'How long the new allowance lasts from when the user signs it (default 24, at most 720)',
  }),
  idempotency_key: IdempotencyKey,
})
export const ConnectionGrantUpdateOutput = Schema.Struct({
  url: Schema.String,
  requested: Schema.Struct({ amount: Schema.String, valid_for_hours: Schema.Int }),
  grant: Schema.NullOr(GrantView),
  message: Schema.String,
  grant_remaining: Schema.String,
})

// 22–23. wallet_topup_quote / wallet_topup_status: top the wallet up from another chain (NEAR Intents 1Click)
export const TopupOriginChain = Schema.Literals(['base', 'solana', 'ethereum', 'arbitrum', 'polygon'])
export const TopupOriginAsset = Schema.Literals(['USDC', 'ETH', 'SOL', 'POL'])
export const TopupStatus = Schema.Literals(['pending', 'processing', 'arrived', 'failed', 'expired'])
export const WalletTopupQuoteInput = Schema.Struct({
  origin_chain: TopupOriginChain.annotate({ description: 'The chain the user sends from' }),
  asset: TopupOriginAsset.annotate({
    description: "USDC, or the chain's native coin: ETH on base, ethereum and arbitrum; SOL on solana; POL on polygon",
  }),
  amount: Schema.String.check(Schema.isPattern(/^\d{1,12}(?:\.\d{1,18})?$/u)).annotate({
    description: 'How much of the asset the user sends, decimal (e.g. "5" or "0.002")',
  }),
  refund_address: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
    description: "The user's own address on the origin chain; a swap that cannot complete is refunded there",
  }),
  idempotency_key: IdempotencyKey,
})
export type WalletTopupQuoteInput = typeof WalletTopupQuoteInput.Type
export const TopupView = Schema.Struct({
  id: Schema.String,
  /** Where to send it on the origin chain. */
  pay_to: Schema.String,
  amount_in: Schema.String,
  /** About this much USDC arrives (decimal; an estimate until it arrives). */
  amount_out: Schema.String,
  origin_chain: Schema.String,
  asset: Schema.String,
  deadline: IsoTime,
  status: TopupStatus,
  /** The sweep that put it in the wallet, once arrived. */
  sweep_tx: Schema.NullOr(Schema.String),
})
export const WalletTopupQuoteOutput = Schema.Struct({
  ...TopupView.fields,
  /** The wallet's Add money card, where the user can follow it too. */
  add_money_url: Schema.String,
  message: Schema.String,
  grant_remaining: Schema.String,
})
export const WalletTopupStatusInput = Schema.Struct({ id: Schema.String, idempotency_key: OptionalKey })

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
  'nod_home',
  'request_create',
  'requests_list',
  'request_pay',
  'request_decline',
  'contact_add',
  'contact_update',
  'contact_remove',
  'wallet_deposit_address',
  'payments_list',
  'connection_grant_update',
  'wallet_topup_quote',
  'wallet_topup_status',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]
