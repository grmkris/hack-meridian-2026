import { HORIZON, USDC_ISSUER } from './config.ts'

const timeout = () => AbortSignal.timeout(3_000)

/** Reads `path` from parsed JSON without trusting its shape. */
const at = (value: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>(
    (current, step) =>
      typeof current === 'object' && current !== null
        ? (Object.entries(current).find(([k]) => k === String(step))?.[1] ?? undefined)
        : undefined,
    value,
  )
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const json = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { signal: timeout(), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${url} → ${response.status}`)
  return response.json()
}

/** Best bid and ask for XLM priced in USDC on the testnet DEX, and the latest closed ledger. Best effort. */
async function market() {
  const [book, ledgers] = await Promise.allSettled([
    json(
      `${HORIZON}/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${USDC_ISSUER}&limit=1`,
    ),
    json(`${HORIZON}/ledgers?order=desc&limit=1`),
  ])
  const b = book.status === 'fulfilled' ? book.value : undefined
  const l = ledgers.status === 'fulfilled' ? ledgers.value : undefined
  const bid = text(at(b, 'bids', 0, 'price'))
  const ask = text(at(b, 'asks', 0, 'price'))
  const mid = bid !== undefined && ask !== undefined ? ((Number(bid) + Number(ask)) / 2).toFixed(7) : null
  const sequence = at(l, '_embedded', 'records', 0, 'sequence')
  const closedAt = text(at(l, '_embedded', 'records', 0, 'closed_at'))
  return {
    xlm_in_usdc: { bid: bid ?? null, ask: ask ?? null, mid },
    ledger: typeof sequence === 'number' && closedAt !== undefined ? { sequence, closed_at: closedAt } : null,
  }
}

export interface BriefContext {
  readonly via: 'http' | 'mcp'
  readonly paymentId: string | null
  readonly topic?: string
}

/** The paid content: a small market brief. It is generated per call, so a cached repeat is visibly the same one. */
export async function marketBrief(context: BriefContext) {
  const facts = await market()
  const mid = facts.xlm_in_usdc.mid
  return {
    title: 'Stellar testnet market brief',
    topic: context.topic ?? 'XLM/USDC',
    generated_at: new Date().toISOString(),
    payment_id: context.paymentId,
    via: context.via,
    price: { amount: '0.10', asset: 'USDC', network: 'stellar:testnet' },
    summary:
      mid === null
        ? 'The testnet DEX order book for XLM/USDC is unavailable right now; ledgers keep closing every ~5 s.'
        : `1 XLM ≈ ${mid} USDC on the testnet DEX (best bid ${facts.xlm_in_usdc.bid}, best ask ${facts.xlm_in_usdc.ask}).`,
    ...facts,
    seller: 'hm26-seller (stellarmcpwallet demo)',
  }
}
