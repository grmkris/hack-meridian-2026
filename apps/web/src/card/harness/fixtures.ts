import type {
  GrantView,
  PaidMcpCallOutput,
  PaidResourceFetchOutput,
  PaymentView,
  ReceiptView,
  WalletOverviewOutput,
} from '@hm/protocol'

/**
 * Tool results the card renders, one per state worth looking at: the harness plays them as a host would (tool input,
 * tool result, then answers to the card's own `tools/call`), the bridge tests drive the same values.
 */

export const ORIGIN = 'https://hack-meridian-testnet.kristjan-grm11775.workers.dev'
export const BOB = 'GD4EDKUSDEAKUCBB633HS634PMX4NE7L6IFY4WOD45RJVKLUP7XLTOTC'
export const CAROL = 'GCAROL7Q2Y3MZ5X4K6W2N4P3R7T5V6B2C4D6F7H2J3K4L5M6N7P2Q3R4'
export const WALLET = 'CD7SGAMIN5JLN6HOD7ENHNJDQ3C4HICTCPKINJOG2PHUNKQS7QLBYHSW'
const TX = '9f2c4a7e1b3d5f6a8c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a'
const PULL_TX = '3b5d7f9a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a9f2c4a7e1b3d5f6a8c0e'
const EXPLORER = 'https://stellar.expert/explorer/testnet/tx'

export interface Fixture {
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly structured: unknown
  readonly sentence: string
  readonly isError?: boolean
  /** What `payment_status` / `wallet_overview` answer, in order; the last answer repeats. */
  readonly polls?: ReadonlyArray<unknown>
}

const receipt = (overrides: Partial<ReceiptView> = {}): ReceiptView => ({
  receipt_id: 'rc_7Hq2',
  payment_id: 'pi_bob20',
  kind: 'payment',
  amount: '20.00',
  asset: 'USDC',
  recipient: BOB,
  recipient_name: 'Bob',
  lane: 'owner',
  tx_hash: TX,
  ledger: 1_284_337,
  confirmed_at: '2026-10-25T18:42:10.000Z',
  explorer_url: `${EXPLORER}/${TX}`,
  pull_tx_hash: null,
  pull_explorer_url: null,
  fee_xlm: '0.0031',
  fee_paid_by: 'relayer',
  requester: 'Claude',
  resource: null,
  ...overrides,
})

const payment = (overrides: Partial<PaymentView> = {}): PaymentView => ({
  payment_id: 'pi_bob20',
  kind: 'payment',
  status: 'awaiting_approval',
  lane: 'owner',
  amount: '20.00',
  asset: 'USDC',
  network: 'stellar:testnet',
  recipient: { name: 'Bob', address: BOB, readiness: 'usdc_ready' },
  fee_ceiling_xlm: 3,
  reason: 'Splitting Saturday’s dinner, Bob paid the whole bill',
  expires_at: '2026-10-26T18:40:00.000Z',
  approval_url: `${ORIGIN}/approve/pi_bob20`,
  claim_url: null,
  receipt: null,
  failure: null,
  next_step: "This needs the user's nod. Ask the user to open the link and approve it with their passkey.",
  grant_remaining: '3.00',
  ...overrides,
})

const confirmed = payment({
  status: 'confirmed',
  approval_url: null,
  receipt: receipt(),
  next_step: 'Confirmed on Stellar; the receipt is final.',
})

const grant: GrantView = {
  grant_id: 'gr_1',
  asset: 'USDC',
  total: '5.00',
  spent: '2.00',
  reserved: '0.00',
  pocket_balance: '0.00',
  remaining: '3.00',
  valid_until: '2026-11-01T12:00:00.000Z',
  status: 'active',
  rule_id: 1,
}

const overview = (overrides: Partial<WalletOverviewOutput> = {}): WalletOverviewOutput => ({
  wallet: { id: 'wal_1', name: 'Personal', contract_id: WALLET, network: 'stellar:testnet' },
  balances: { usdc: '48.50', xlm: '0.00' },
  grant,
  pending_approvals: [payment()],
  recent_receipts: [
    receipt({ receipt_id: 'rc_1', amount: '2.00', recipient_name: 'Alice', lane: 'autonomous' }),
    receipt({
      receipt_id: 'rc_2',
      kind: 'x402_fetch',
      amount: '0.10',
      recipient: WALLET,
      recipient_name: null,
      resource: 'https://weather.x402.example/forecast',
      confirmed_at: '2026-10-25T16:05:00.000Z',
    }),
  ],
  connection: { id: 'con_1', client_name: 'Claude', status: 'active' },
  grant_remaining: '3.00',
  ...overrides,
})

const fetchResult = (overrides: Partial<PaidResourceFetchOutput> = {}): PaidResourceFetchOutput => ({
  status: 'paid',
  payment_id: 'pi_wx',
  http_status: 200,
  content_type: 'application/json',
  body: JSON.stringify({ city: 'Lisbon', today: { high: 22, low: 15, sky: 'clear' } }, null, 2),
  price: '0.10',
  receipt: receipt({
    receipt_id: 'rc_wx',
    payment_id: 'pi_wx',
    kind: 'x402_fetch',
    amount: '0.10',
    recipient: 'GSELLER2Y3MZ5X4K6W2N4P3R7T5V6B2C4D6F7H2J3K4L5M6N7P2Q3R4',
    recipient_name: null,
    lane: 'autonomous',
    pull_tx_hash: PULL_TX,
    pull_explorer_url: `${EXPLORER}/${PULL_TX}`,
    fee_paid_by: 'facilitator',
    resource: 'https://weather.x402.example/forecast?city=lisbon',
  }),
  approval_url: null,
  message: 'Paid 0.10 USDC from the allowance.',
  grant_remaining: '2.90',
  ...overrides,
})

const mcpResult = (overrides: Partial<PaidMcpCallOutput> = {}): PaidMcpCallOutput => ({
  status: 'paid',
  payment_id: 'pi_mcp',
  result: { content: [{ type: 'text', text: 'Translated: «Bom dia, Lisboa»' }] },
  price: '0.05',
  receipt: receipt({
    receipt_id: 'rc_mcp',
    payment_id: 'pi_mcp',
    kind: 'x402_mcp',
    amount: '0.05',
    recipient_name: null,
    lane: 'autonomous',
    fee_paid_by: 'facilitator',
    resource: 'https://translate.x402.example/mcp#translate',
  }),
  approval_url: null,
  message: 'Paid 0.05 USDC from the allowance.',
  grant_remaining: '2.95',
  ...overrides,
})

const PREPARE = { recipient: 'Bob', amount: '20', idempotency_key: 'k-bob-20' }
const FETCH = { url: 'https://weather.x402.example/forecast?city=lisbon', max_amount: '0.50', idempotency_key: 'k-wx' }

export const FIXTURES: Readonly<Record<string, Fixture>> = {
  'payment-needs-nod': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: payment(),
    sentence: 'This payment of 20.00 USDC to Bob needs the user’s nod.',
  },
  'payment-needs-nod-then-receipt': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: payment(),
    sentence: 'This payment of 20.00 USDC to Bob needs the user’s nod.',
    polls: [payment(), payment({ status: 'submitted', approval_url: null }), confirmed],
  },
  'payment-ready': {
    tool: 'payment_prepare',
    arguments: { recipient: 'Alice', amount: '2', idempotency_key: 'k-alice' },
    structured: payment({
      payment_id: 'pi_alice2',
      status: 'prepared',
      lane: 'autonomous',
      amount: '2.00',
      recipient: { name: 'Alice', address: WALLET, readiness: 'usdc_ready' },
      reason: 'Coffee beans, her turn last week',
      approval_url: null,
      next_step: 'Within the allowance. Call payment_execute with payment_id pi_alice2 to pay.',
    }),
    sentence: 'Within the allowance.',
  },
  'payment-paying': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: payment({ status: 'submitted', approval_url: null, reason: null }),
    sentence: 'Submitted.',
  },
  'payment-receipt': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: confirmed,
    sentence: 'Confirmed.',
  },
  'payment-claim': {
    tool: 'payment_prepare',
    arguments: { recipient: 'Carol', amount: '5', idempotency_key: 'k-carol' },
    structured: payment({
      payment_id: 'pi_carol5',
      status: 'approved',
      amount: '5.00',
      recipient: { name: 'Carol', address: CAROL, readiness: 'trustline_required' },
      reason: 'Her half of the concert tickets',
      approval_url: null,
      claim_url: `${ORIGIN}/claim/pi_carol5`,
    }),
    sentence: 'Waiting for Carol to accept.',
  },
  'payment-failed': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: payment({ status: 'failed', approval_url: null, failure: 'The recipient account does not exist.' }),
    sentence: 'Failed.',
  },
  'payment-expired': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: payment({ status: 'expired', approval_url: null }),
    sentence: 'Expired.',
  },
  'purchase-paid': {
    tool: 'paid_resource_fetch',
    arguments: FETCH,
    structured: fetchResult(),
    sentence: 'Paid 0.10 USDC.',
  },
  'purchase-needs-nod': {
    tool: 'paid_resource_fetch',
    arguments: {
      ...FETCH,
      url: 'https://reports.x402.example/q3.pdf',
      max_amount: '12',
      reason: 'The Q3 market report you asked for',
    },
    structured: fetchResult({
      status: 'requires_approval',
      payment_id: 'pi_report',
      http_status: 402,
      content_type: null,
      body: null,
      price: '9.00',
      receipt: null,
      approval_url: `${ORIGIN}/approve/pi_report`,
      message: 'The price is more than this AI app’s allowance has left, so it needs the user’s nod.',
      grant_remaining: '3.00',
    }),
    sentence: 'Needs the user’s nod.',
  },
  'purchase-refused': {
    tool: 'paid_resource_fetch',
    arguments: FETCH,
    structured: fetchResult({
      status: 'refused',
      payment_id: null,
      http_status: 402,
      body: null,
      receipt: null,
      price: '0.80',
      message: 'The price 0.80 USDC is above the limit the AI set (0.50 USDC). Nothing was paid.',
    }),
    sentence: 'Refused.',
  },
  'mcp-paid': {
    tool: 'paid_mcp_call',
    arguments: { server_url: 'https://translate.x402.example/mcp', tool: 'translate', idempotency_key: 'k-tr' },
    structured: mcpResult(),
    sentence: 'Paid 0.05 USDC.',
  },
  wallet: { tool: 'wallet_overview', arguments: {}, structured: overview(), sentence: 'The wallet holds 48.50 USDC.' },
  'wallet-no-allowance': {
    tool: 'wallet_overview',
    arguments: {},
    structured: overview({ grant: null, pending_approvals: [], recent_receipts: [], grant_remaining: '0.00' }),
    sentence: 'No allowance.',
  },
  'allowance-link': {
    tool: 'connection_grant_create',
    arguments: { idempotency_key: 'k-grant' },
    structured: {
      url: `${ORIGIN}/approve/grant/con_1`,
      grant,
      message: 'Ask the user to open the link to raise the allowance.',
      grant_remaining: '3.00',
    },
    sentence: 'Open the link.',
  },
  'revoked-pending': {
    tool: 'connection_grant_revoke',
    arguments: { idempotency_key: 'k-rev' },
    structured: {
      status: 'revoked',
      onchain: 'pending_owner',
      approval_url: `${ORIGIN}/approve/revoke/con_1`,
      sweep_tx: TX,
      message: 'Revoked.',
      grant_remaining: '0.00',
    },
    sentence: 'Revoked.',
  },
  home: {
    tool: 'nod_home',
    arguments: {},
    structured: overview(),
    sentence: 'The wallet holds 48.50 USDC.',
    polls: [overview()],
  },
  'tool-error': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: undefined,
    isError: true,
    sentence: 'No contact named Bobby. Search contacts first, or pass a Stellar address.',
  },
}
