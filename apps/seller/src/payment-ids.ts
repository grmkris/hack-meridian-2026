import { DurableObject } from 'cloudflare:workers'

/** A settled response, replayed byte for byte when the same payment id comes back. */
export interface CachedResponse {
  readonly status: number
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}

type Entry =
  | { readonly fingerprint: string; readonly state: 'pending'; readonly since: number }
  | { readonly fingerprint: string; readonly state: 'done'; readonly at: number; readonly response: CachedResponse }

export type Claim =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'hit'; readonly response: CachedResponse }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'pending' }

/** A request that claimed an id and never completed (isolate died mid-settle) stops blocking it after this. */
const PENDING_MS = 90_000

/**
 * x402 `payment-identifier` dedup, one Durable Object per payment id (`idFromName(id)`). `@x402/hono` 2.28.0 declares
 * the extension but does not cache (docs/spikes/s2.md §2), so the seller does: the first request with an id claims it,
 * settles, and stores the 200; a repeat with the same fingerprint gets that stored response without reaching the
 * facilitator; the same id with different terms is a conflict. The claim is one get + put inside the object's input
 * gate, so two concurrent requests with one id cannot both proceed.
 */
export class PaymentIds extends DurableObject {
  async claim(fingerprint: string): Promise<Claim> {
    const entry = await this.ctx.storage.get<Entry>('entry')
    if (entry !== undefined && entry.fingerprint !== fingerprint) return { kind: 'conflict' }
    if (entry?.state === 'done') return { kind: 'hit', response: entry.response }
    if (entry?.state === 'pending' && Date.now() - entry.since < PENDING_MS) return { kind: 'pending' }
    await this.ctx.storage.put<Entry>('entry', { fingerprint, state: 'pending', since: Date.now() })
    return { kind: 'proceed' }
  }

  async complete(fingerprint: string, response: CachedResponse): Promise<void> {
    await this.ctx.storage.put<Entry>('entry', { fingerprint, state: 'done', at: Date.now(), response })
  }

  async release(fingerprint: string): Promise<void> {
    const entry = await this.ctx.storage.get<Entry>('entry')
    if (entry?.state === 'pending' && entry.fingerprint === fingerprint) await this.ctx.storage.delete('entry')
  }
}
