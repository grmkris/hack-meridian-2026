import { DurableObject } from 'cloudflare:workers'

export type PaymentStatus = 'awaiting_approval' | 'submitted' | 'confirmed' | 'expired'

export interface PaymentIntent {
  payment_id: string
  idempotency_key?: string
  connection_id: string
  requester: string
  recipient: string
  amount: string
  asset: 'USDC'
  network: 'stellar:testnet'
  reason?: string
  lane: 'owner'
  created_at: string
  expires_at: string
  approved_at?: string
  receipt?: Receipt
}

export interface Receipt {
  tx_hash: string
  ledger: number
  explorer_url: string
  confirmed_at: string
  lane: 'owner'
  note: string
}

const APPROVAL_TTL_MS = 30 * 60 * 1000
/** Pretend submission takes this long after approval, so pollers see `submitted` before `confirmed`. */
const SETTLE_MS = 2000

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Status is derived from timestamps on read: opening or polling never changes state. */
export function statusOf(intent: PaymentIntent, now = Date.now()): PaymentStatus {
  if (intent.approved_at !== undefined)
    return now - Date.parse(intent.approved_at) < SETTLE_MS ? 'submitted' : 'confirmed'
  return now > Date.parse(intent.expires_at) ? 'expired' : 'awaiting_approval'
}

/**
 * One serialized ledger of payment intents (spike: a single instance named "ledger"). A Durable Object, not KV,
 * because payment_status must see the approval immediately and KV reads can be up to 60 s stale.
 */
export class Payments extends DurableObject {
  async prepare(
    input: Omit<PaymentIntent, 'payment_id' | 'created_at' | 'expires_at' | 'lane'>,
  ): Promise<PaymentIntent> {
    if (input.idempotency_key !== undefined) {
      const existing = await this.ctx.storage.get<string>(`idem:${input.connection_id}:${input.idempotency_key}`)
      if (existing !== undefined) {
        const intent = await this.ctx.storage.get<PaymentIntent>(`intent:${existing}`)
        if (intent !== undefined) return intent
      }
    }
    const now = Date.now()
    const intent: PaymentIntent = {
      ...input,
      payment_id: `pi_${hex(12)}`,
      lane: 'owner',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    }
    await this.ctx.storage.put(`intent:${intent.payment_id}`, intent)
    if (input.idempotency_key !== undefined)
      await this.ctx.storage.put(`idem:${input.connection_id}:${input.idempotency_key}`, intent.payment_id)
    return intent
  }

  async get(paymentId: string): Promise<PaymentIntent | undefined> {
    return this.ctx.storage.get<PaymentIntent>(`intent:${paymentId}`)
  }

  async pending(connectionId: string): Promise<number> {
    const all = await this.ctx.storage.list<PaymentIntent>({ prefix: 'intent:' })
    return [...all.values()].filter(i => i.connection_id === connectionId && statusOf(i) === 'awaiting_approval').length
  }

  /** The owner pressed Approve. Idempotent: a second press returns the same receipt. */
  async approve(paymentId: string): Promise<PaymentIntent | { error: string }> {
    const intent = await this.get(paymentId)
    if (intent === undefined) return { error: 'unknown payment' }
    if (intent.approved_at !== undefined) return intent
    if (statusOf(intent) === 'expired') return { error: 'expired' }
    const approvedAt = new Date()
    const txHash = hex(32)
    const approved: PaymentIntent = {
      ...intent,
      approved_at: approvedAt.toISOString(),
      receipt: {
        tx_hash: txHash,
        ledger: 0,
        explorer_url: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        confirmed_at: new Date(approvedAt.getTime() + SETTLE_MS).toISOString(),
        lane: 'owner',
        note: 'FAKE receipt (spike S4): no transaction was submitted',
      },
    }
    await this.ctx.storage.put(`intent:${paymentId}`, approved)
    return approved
  }
}

export const ledger = (ns: DurableObjectNamespace<Payments>) => ns.get(ns.idFromName('ledger'))
