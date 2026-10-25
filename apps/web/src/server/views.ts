import type { GrantView as ApiGrantView, PendingApproval } from '@hm/api'
import {
  fromStroops,
  type Connection,
  type GrantView,
  type PaymentIntent,
  type PaymentView,
  type ReceiptRecord,
  type ReceiptView,
  type SpendingGrant,
} from '@hm/protocol'

import { effectiveStatus, remainingOf } from './ledger.ts'

/** Projections of stored entities onto what each surface shows. The two numbers stay separate everywhere. */

export const approvalUrl = (origin: string, intentId: string) => `${origin}/approve/${intentId}`
export const claimUrl = (origin: string, intentId: string) => `${origin}/claim/${intentId}`
export const revokeUrl = (origin: string, connectionId: string) => `${origin}/approve/revoke/${connectionId}`

/** For the SPA: stroops as strings. */
export const apiGrantView = (connection: Connection, grant: SpendingGrant | undefined): ApiGrantView => ({
  connection_id: connection.id,
  client_name: connection.oauth_client_name,
  client_domain: connection.oauth_client_domain,
  connection_status: connection.status,
  grant_id: grant?.id ?? null,
  total: (grant?.total ?? 0n).toString(),
  spent: (grant?.spent ?? 0n).toString(),
  reserved: (grant?.reserved ?? 0n).toString(),
  pocket_balance: (grant?.pocket_balance ?? 0n).toString(),
  remaining: (grant === undefined || grant.status !== 'active' ? 0n : remainingOf(grant)).toString(),
  valid_until: grant?.valid_until ?? null,
  grant_status: grant?.status ?? null,
  rule_status: grant?.rule_status ?? null,
  rule_id: grant?.rule_id ?? null,
  install_tx: grant?.install_tx ?? null,
  remove_tx: grant?.remove_tx ?? null,
  sweep_tx: grant?.sweep_tx ?? null,
  created_at: connection.created_at,
  revoked_at: connection.revoked_at,
})

export const pendingApproval = (intent: PaymentIntent, origin: string): PendingApproval => ({
  intent_id: intent.id,
  requester: intent.requester,
  reason: intent.reason,
  recipient_name: intent.recipient_name,
  recipient_address: intent.recipient_address,
  amount: intent.amount.toString(),
  asset: intent.asset,
  expires_at: intent.expires_at,
  approve_url: approvalUrl(origin, intent.id),
})

/** For the agent: decimal strings. */
export const grantRemaining = (grant: SpendingGrant | undefined, nowMs: number): string =>
  grant === undefined || grant.status !== 'active' || Date.parse(grant.valid_until) <= nowMs
    ? '0.00'
    : fromStroops(remainingOf(grant))

export const toolGrantView = (grant: SpendingGrant, nowMs: number): GrantView => ({
  grant_id: grant.id,
  asset: grant.asset,
  total: fromStroops(grant.total),
  spent: fromStroops(grant.spent),
  reserved: fromStroops(grant.reserved),
  pocket_balance: fromStroops(grant.pocket_balance),
  remaining: grantRemaining(grant, nowMs),
  valid_until: grant.valid_until,
  status: grant.status === 'active' && Date.parse(grant.valid_until) <= nowMs ? 'expired' : grant.status,
  rule_id: grant.rule_id,
})

export const receiptView = (receipt: ReceiptRecord): ReceiptView => ({
  receipt_id: receipt.id,
  payment_id: receipt.intent_id,
  kind: receipt.kind,
  amount: fromStroops(receipt.amount),
  asset: receipt.asset,
  recipient: receipt.recipient_address,
  recipient_name: receipt.recipient_name,
  lane: receipt.lane,
  tx_hash: receipt.tx_hash,
  ledger: receipt.ledger,
  confirmed_at: receipt.confirmed_at,
  explorer_url: receipt.explorer_url,
  pull_tx_hash: receipt.pull_tx_hash,
  pull_explorer_url: receipt.pull_explorer_url,
  fee_xlm: fromStroops(receipt.fee_stroops),
  fee_paid_by: receipt.fee_paid_by,
  requester: receipt.requester,
  resource: receipt.resource,
})

const nextStep = (intent: PaymentIntent, status: PaymentIntent['status'], url: string | null): string => {
  switch (status) {
    case 'prepared':
      return `Within the allowance. Call payment_execute with payment_id ${intent.id} to pay.`
    case 'awaiting_approval':
      return intent.recipient_readiness === 'trustline_required'
        ? `This needs the user's nod, and the recipient accepts on a claim link: ask the user to open ${url ?? ''} and approve it with their passkey, then poll payment_status with payment_id ${intent.id}.`
        : `This needs the user's nod. Ask the user to open ${url ?? ''} and approve it with their passkey, then poll payment_status with payment_id ${intent.id}.`
    case 'approved':
      if (intent.kind !== 'payment')
        return `The user approved this purchase and the price is in this AI app's pocket. Call ${intent.kind === 'x402_mcp' ? 'paid_mcp_call' : 'paid_resource_fetch'} again with the same idempotency_key to complete it.`
      return intent.recipient_readiness === 'trustline_required'
        ? `The user approved. Waiting for ${intent.recipient_name ?? 'the recipient'} to accept on the claim link; poll payment_status with payment_id ${intent.id}.`
        : `Approved. Poll payment_status with payment_id ${intent.id}.`
    case 'reserved':
    case 'submitted':
      return `Submitted. Poll payment_status with payment_id ${intent.id}; it never pays twice.`
    case 'confirmed':
      return 'Confirmed on Stellar; the receipt is final.'
    case 'failed':
      return `Failed: ${intent.failure ?? 'unknown'}. Prepare a new payment with a new idempotency key if it should be retried.`
    case 'expired':
      return 'Expired before it was submitted. Prepare a new payment with a new idempotency key.'
    default:
      return status
  }
}

export const paymentView = (
  intent: PaymentIntent,
  receipt: ReceiptRecord | undefined,
  grant: SpendingGrant | undefined,
  origin: string,
  nowMs: number,
): PaymentView => {
  const status = effectiveStatus(intent, nowMs)
  const url = status === 'awaiting_approval' ? approvalUrl(origin, intent.id) : null
  return {
    payment_id: intent.id,
    kind: intent.kind,
    status,
    lane: intent.lane,
    amount: fromStroops(intent.amount),
    asset: intent.asset,
    network: intent.network,
    recipient: {
      name: intent.recipient_name,
      address: intent.recipient_address,
      readiness: intent.recipient_readiness,
    },
    fee_ceiling_xlm: intent.fee_ceiling_xlm,
    reason: intent.reason,
    expires_at: intent.expires_at,
    approval_url: url,
    claim_url:
      intent.recipient_readiness === 'trustline_required' && status !== 'confirmed'
        ? claimUrl(origin, intent.id)
        : null,
    receipt: status === 'confirmed' && receipt !== undefined ? receiptView(receipt) : null,
    failure: intent.failure,
    next_step: nextStep(intent, status, url),
    grant_remaining: grantRemaining(grant, nowMs),
  }
}
