/**
 * The sample run (`/sample`): what a run is, what each log line says, and the fixed numbers. Nothing here comes from
 * the visitor: the amounts, recipients, URL and limits are constants, so no user input reaches the chain.
 */

/**
 * The demo beats, the same as the judge path and sized to a 10 USDC wallet (one number, Kristjan 18:20 UTC: the
 * allowance is the agent's total; past what is left, the owner's nod each time): the allowance, the x402 price and
 * Alice (inside it: alone), the dinner (above the 2.90 left, so it needs the nod), the ask above what is left, Carol
 * through the claim link (the owner's lane, because she cannot take USDC yet).
 */
export const SAMPLE_AMOUNTS = {
  allowance: '5',
  brief: '0.10',
  alice: '2',
  dinner: '5',
  tooMuch: '4',
  carol: '1',
  /** At most 1.00 (pocket pull) + 2 + 5 + 1; the pocket's 0.90 comes back on revoke. */
  runSpend: '9',
  /** The treasury tops the demo wallet up to this before a run. */
  walletFloor: '10',
} as const

/** Stream C's seller (apps/seller): a 0.10 USDC market brief behind x402 on Stellar testnet. */
export const MARKET_BRIEF_URL = 'https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief'

/** The allowance lives a day, like the consent page's default ("until tomorrow"). */
export const ALLOWANCE_LIFETIME_S = 86_400

/** The sample agent as the wallet lists it (a connection without an OAuth client behind it). */
export const SAMPLE_CLIENT = { id: 'nod:sample-agent', name: 'Sample agent' } as const

/**
 * Guards. One run at a time; at most six an hour across all visitors and one per visitor (cf-connecting-ip) every ten
 * minutes. A run that has not finished after `staleMs` (the Durable Object alarm's 15 min wall clock) frees the lock.
 * The treasury keeps `treasuryFloorUsdc` for new wallets (the judge path's 10 USDC welcome): below it, no top-up.
 */
export const SAMPLE_LIMITS = {
  perHour: 4,
  perVisitorMs: 10 * 60 * 1000,
  staleMs: 16 * 60 * 1000,
  treasuryFloorUsdc: '60',
} as const

export type LineState =
  | 'running'
  | 'ok'
  | 'paid'
  | 'needs_nod'
  | 'nodded'
  | 'same_receipt'
  | 'left_pending'
  | 'skipped'
  | 'refused'
  | 'revoked'
  | 'failed'

export interface SampleLink {
  readonly label: string
  readonly url: string
}

/** One line of the live log. `step` is '0' for setup, '1'–'9' for the demo steps, 'end' for the summary. */
export interface SampleLine {
  readonly step: string
  readonly title: string
  /** The MCP tool or owner page this line used, for readers who know the protocol. */
  readonly tool: string | null
  readonly state: LineState
  readonly amount: string | null
  /** Who paid the network fee, e.g. "Nod paid 28.8 XLM". */
  readonly fee: string | null
  readonly detail: string
  readonly links: ReadonlyArray<SampleLink>
}

export interface SampleRun {
  readonly id: string
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly created_at: string
  readonly finished_at: string | null
  readonly lines: ReadonlyArray<SampleLine>
  readonly error: string | null
}

/** Where the run's passkey ceremonies and links live (the stage's origin and RP id). */
export interface SampleSite {
  readonly origin: string
  readonly rpId: string
}

export type StartReply =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false
      readonly reason: 'busy' | 'hourly' | 'visitor'
      readonly message: string
      readonly retry_after_s: number
      /** The run in progress, which the page shows instead. */
      readonly current: string | null
    }
