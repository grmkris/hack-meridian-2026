import type {
  GrantView,
  RequestView,
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

export const ORIGIN = 'https://testnet.trynod.si'
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
  /** Answers for named tools (request_pay, requests_list, …), in order; the last answer repeats. */
  readonly answers?: Readonly<Record<string, ReadonlyArray<unknown>>>
  /** The host holds the call open (a URL request for the passkey): the card gets the arguments and no result yet. */
  readonly pending?: boolean
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

const request = (overrides: Partial<RequestView> = {}): RequestView => ({
  request_id: 'rq_dinner',
  direction: 'incoming',
  status: 'open',
  amount: '12.50',
  asset: 'USDC',
  network: 'stellar:testnet',
  requester: { address: 'CBOBWALLET5JLN6HOD7ENHNJDQ3C4HICTCPKINJOG2PHUNKQS7QLBYH', contact_name: 'Bob', is_you: false },
  payer: { address: WALLET, contact_name: null, is_you: true },
  payer_is_nod_wallet: true,
  note: 'Your half of Saturday’s dinner 🍝',
  request_url: `${ORIGIN}/approve/request/rq_dinner`,
  payment_id: null,
  receipt: null,
  expires_at: '2026-11-01T18:00:00.000Z',
  created_at: '2026-10-25T18:00:00.000Z',
  next_step: 'Call request_pay with request_id rq_dinner to pay it, or request_decline.',
  ...overrides,
})

const STRANGER = request({
  request_id: 'rq_stranger',
  amount: '40.00',
  requester: { address: 'CSTRANGER2N4P3R7T5V6B2C4D6F7H2J3K4L5M6N7P2Q3R4S5T6U7V2W', contact_name: null, is_you: false },
  note: 'Invoice 2291, pay today please',
  request_url: `${ORIGIN}/approve/request/rq_stranger`,
})

const REQUEST_PAYMENT = {
  ...payment({
    payment_id: 'pi_rq_dinner',
    amount: '12.50',
    recipient: {
      name: 'Bob',
      address: 'CBOBWALLET5JLN6HOD7ENHNJDQ3C4HICTCPKINJOG2PHUNKQS7QLBYH',
      readiness: 'usdc_ready',
    },
    reason: 'Payment request rq_dinner from Bob',
    approval_url: `${ORIGIN}/approve/pi_rq_dinner`,
  }),
  request_id: 'rq_dinner',
}

/** Worst realistic data: the longest names the forms accept, 7-decimal amounts, muxed addresses, the 280-character reason. */
const LONG_NAME = 'Aleksandra Wiśniewska-Kowalczyk (flat 3B, Rua da Madalena)'
const MUXED = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAGZFQ'
const WORST_REASON =
  'Reimbursing her for the shared groceries order (Pingo Doce, 23 Oct, receipt #PD-2026-10-23-004417) plus her half of the internet bill for October; she asked in the flat group chat at 21:40 and confirmed the amount twice: https://chat.example.com/flat-3b/messages/88412'
const worstPayment = payment({
  payment_id: 'pi_worst',
  amount: '87.6543219',
  recipient: { name: LONG_NAME, address: MUXED, readiness: 'usdc_ready' },
  reason: WORST_REASON,
  grant_remaining: '0.0000001',
  approval_url: `${ORIGIN}/approve/pi_worst`,
})
const worstOverview = overview({
  wallet: {
    id: 'wal_w',
    name: 'Household wallet for the Lisbon flat 3B',
    contract_id: WALLET,
    network: 'stellar:testnet',
  },
  balances: { usdc: '1284050.1234567', xlm: '0.00' },
  grant: {
    ...grant,
    total: '100.00',
    remaining: '0.0000001',
    spent: '99.9999999',
    valid_until: '2026-10-25T23:59:59.000Z',
  },
  pending_approvals: [
    worstPayment,
    payment({
      payment_id: 'pi_w2',
      amount: '100.00',
      recipient: { name: null, address: MUXED, readiness: 'usdc_ready' },
    }),
    payment({
      payment_id: 'pi_w3',
      amount: '0.0000001',
      recipient: { name: 'Jo', address: BOB, readiness: 'usdc_ready' },
    }),
  ],
  recent_receipts: Array.from({ length: 12 }, (_, index) =>
    receipt({
      receipt_id: `rc_w${index}`,
      amount: index % 2 === 0 ? '99.9999999' : '0.01',
      recipient: index % 3 === 0 ? MUXED : BOB,
      recipient_name: index % 3 === 0 ? null : LONG_NAME,
    }),
  ),
  connection: { id: 'con_w', client_name: 'Claude Code (bartholomew’s MacBook Pro, work profile)', status: 'active' },
})

const PREPARE = { recipient: 'Bob', amount: '20', idempotency_key: 'k-bob-20' }
const FETCH = { url: 'https://weather.x402.example/forecast?city=lisbon', max_amount: '0.50', idempotency_key: 'k-wx' }

const topup = (status: 'pending' | 'processing' | 'arrived' | 'failed' | 'expired') => ({
  id: 'tq_9f1c',
  pay_to: '0x5b1e2f0c9d4a7e6b3c8f1a2d4e6b8c0a1f3e5d7c',
  amount_in: '5',
  amount_out: '4.98',
  origin_chain: 'base',
  asset: 'USDC',
  deadline: '2026-10-26T00:10:00.000Z',
  status,
  sweep_tx: status === 'arrived' ? 'edc8f3b2c15e0c9d3a7b1f4e2d6c8a0b9e7f5d3c1a2b4e6d8f0a9c7e5b3d1f2a' : null,
})
const TOPUP_ARGS = {
  origin_chain: 'base',
  asset: 'USDC',
  amount: '5',
  refund_address: '0x2a9c51f3b7d64e0c8a1f5d3b9e7c2a4f6d8b0e1c',
  idempotency_key: 'k-topup',
}

export const FIXTURES: Readonly<Record<string, Fixture>> = {
  'recipient-scan': {
    tool: 'recipient_scan',
    arguments: {},
    sentence: 'Scan a recipient.',
    structured: { kind: 'recipient_scan', network: 'stellar:testnet', grant_remaining: '5.00' },
    answers: {
      recipient_read: [
        {
          kind: 'recipient',
          address: BOB,
          address_kind: 'account',
          network: 'stellar:testnet',
          grant_remaining: '5.00',
        },
      ],
    },
  },
  'topup-pending': {
    tool: 'wallet_topup_quote',
    arguments: TOPUP_ARGS,
    structured: {
      ...topup('pending'),
      add_money_url: `${ORIGIN}/#add-money`,
      message: 'Send 5 USDC on Base.',
      grant_remaining: '3.00',
    },
    sentence: 'Send 5 USDC on Base to 0x5b1e… within 30 minutes; it arrives as about 4.98 USDC in your Nod wallet.',
    polls: [topup('pending')],
  },
  'topup-arrives': {
    tool: 'wallet_topup_quote',
    arguments: TOPUP_ARGS,
    structured: {
      ...topup('pending'),
      add_money_url: `${ORIGIN}/#add-money`,
      message: 'Send 5 USDC on Base.',
      grant_remaining: '3.00',
    },
    sentence: 'Send 5 USDC on Base.',
    polls: [topup('processing'), topup('arrived')],
  },
  'topup-arrived': {
    tool: 'wallet_topup_status',
    arguments: { id: 'tq_9f1c' },
    structured: topup('arrived'),
    sentence: 'About 4.98 USDC arrived.',
  },
  'payment-asked': {
    tool: 'payment_prepare',
    arguments: { ...PREPARE, reason: 'Dinner at Taberna, split with Bob' },
    structured: payment(),
    sentence: '',
    pending: true,
  },
  'payment-claim-link': {
    tool: 'payment_prepare',
    arguments: {
      recipient: 'new',
      recipient_name: 'Jan',
      amount: '1',
      reason: 'Coffee on Friday',
      idempotency_key: 'k-jan',
    },
    structured: payment({
      payment_id: 'cl_bd709ee9a1c24e5f8d3b6a7c9e0f1234',
      status: 'prepared',
      lane: 'autonomous',
      amount: '1.00',
      recipient: { name: 'Jan', address: '', readiness: 'unverified' },
      reason: 'Coffee on Friday',
      approval_url: null,
      claim_url: `${ORIGIN}/claim/cl_bd709ee9a1c24e5f8d3b6a7c9e0f1234`,
      next_step: 'Send Jan the claim link; Nod pays when Jan opens it and picks where the money goes.',
    }),
    sentence: 'Claim link for Jan. Nothing is paid yet.',
  },
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
  'request-incoming': {
    tool: 'requests_list',
    arguments: { direction: 'incoming' },
    structured: { requests: [request()], grant_remaining: '3.00' },
    sentence: '1 payment request; 1 waiting for this wallet to pay.',
    answers: { request_pay: [REQUEST_PAYMENT], request_decline: [request({ status: 'declined' })] },
  },
  'request-single': {
    tool: 'request_create',
    arguments: { payer: 'Alice', amount: '8', idempotency_key: 'k-rq' },
    structured: request({
      request_id: 'rq_tickets',
      direction: 'outgoing',
      amount: '8.00',
      requester: { address: WALLET, contact_name: null, is_you: true },
      payer: {
        address: 'CALICEWALLET6HOD7ENHNJDQ3C4HICTCPKINJOG2PHUNKQS7QLBYHSW',
        contact_name: 'Alice',
        is_you: false,
      },
      note: 'Concert tickets, Friday',
      request_url: `${ORIGIN}/approve/request/rq_tickets`,
    }),
    sentence: 'Asked Alice for 8.00 USDC on Stellar Testnet; it is in their Nod inbox.',
  },
  'request-stranger': {
    tool: 'request_create',
    arguments: {},
    structured: STRANGER,
    sentence: 'A stranger asks for 40.00 USDC.',
    answers: {
      request_pay: [{ ...REQUEST_PAYMENT, payment_id: 'pi_rq_stranger', amount: '40.00', request_id: 'rq_stranger' }],
    },
  },
  'requests-list': {
    tool: 'requests_list',
    arguments: {},
    structured: {
      requests: [
        request(),
        STRANGER,
        request({
          request_id: 'rq_tickets',
          direction: 'outgoing',
          status: 'paid',
          amount: '8.00',
          requester: { address: WALLET, contact_name: null, is_you: true },
          payer: {
            address: 'CALICEWALLET6HOD7ENHNJDQ3C4HICTCPKINJOG2PHUNKQS7QLBYHSW',
            contact_name: 'Alice',
            is_you: false,
          },
          receipt: receipt({ amount: '8.00', recipient_name: null }),
        }),
      ],
      grant_remaining: '3.00',
    },
    sentence: '3 payment requests; 2 waiting for this wallet to pay.',
    answers: { request_pay: [REQUEST_PAYMENT] },
  },
  'home-inbox': {
    tool: 'nod_home',
    arguments: {},
    structured: overview(),
    sentence: 'The wallet holds 48.50 USDC.',
    polls: [overview()],
    answers: { requests_list: [{ requests: [request(), STRANGER], grant_remaining: '3.00' }] },
  },
  'worst-payment-needs-nod': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: { ...worstPayment, claim_url: `${ORIGIN}/claim/pi_worst` },
    sentence: 'Needs the nod.',
  },
  'worst-payment-receipt': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: {
      ...worstPayment,
      status: 'confirmed',
      approval_url: null,
      receipt: receipt({ amount: '87.6543219', recipient: MUXED, recipient_name: LONG_NAME, ledger: 2_147_483_647 }),
    },
    sentence: 'Confirmed.',
  },
  'worst-payment-failed': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: {
      ...worstPayment,
      status: 'failed',
      approval_url: null,
      failure:
        'simulation failed: HostError: Error(Contract, #10) Event log (newest first): 0: [Diagnostic Event] contract:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA, topics:[error, Error(Contract, #10)], data:"balance is not sufficient to spend"',
    },
    sentence: 'Failed.',
  },
  'worst-wallet': { tool: 'wallet_overview', arguments: {}, structured: worstOverview, sentence: 'Worst wallet.' },
  'worst-home': {
    tool: 'nod_home',
    arguments: {},
    structured: worstOverview,
    sentence: 'Worst wallet.',
    polls: [worstOverview],
    answers: {
      requests_list: [
        {
          requests: [
            request({
              request_id: 'rq_w1',
              amount: '99.9999999',
              requester: { address: MUXED, contact_name: LONG_NAME, is_you: false },
              note: 'Dzień dobry! 🎉 Zaległa część za bilety na koncert w Coliseu dos Recreios + parking + kolacja po koncercie (wszystko razem)',
            }),
            STRANGER,
          ],
          grant_remaining: '0.0000001',
        },
      ],
    },
  },
  'worst-purchase': {
    tool: 'paid_resource_fetch',
    arguments: {
      url: 'https://api.weather-forecasts.northwind-industries-holdings.example.com/v3/forecast/lisbon?days=14&units=metric&lang=pt-PT',
      max_amount: '0.0000001',
      idempotency_key: 'k',
    },
    structured: fetchResult({
      status: 'failed',
      payment_id: 'pi_wfail',
      body: null,
      receipt: null,
      price: '0.0123456',
      pull: { tx_hash: PULL_TX, explorer_url: `${EXPLORER}/${PULL_TX}`, amount: '1.00' },
      facilitator_message:
        'settle_exact_stellar: transaction simulation failed with txBadSeq after 3 attempts; the facilitator did not submit the payment and the authorization entry expired at ledger 1284400',
      message:
        'The seller took the authorization but the facilitator could not settle it. 1.00 USDC moved into the pocket and stays there for the next purchase.',
    }),
    sentence: 'Failed.',
  },
  'worst-mcp': {
    tool: 'paid_mcp_call',
    arguments: {
      server_url: 'https://mcp.translate-and-summarise.northwind-industries-holdings.example.com/mcp',
      tool: 'summarise_document_with_citations',
      idempotency_key: 'k',
    },
    structured: mcpResult({
      result: {
        content: [
          {
            type: 'text',
            text: 'Resumo: '.concat(
              'O relatório trimestral indica crescimento sustentado nas receitas recorrentes. '.repeat(20),
            ),
          },
        ],
        structuredContent: {
          citations: Array.from({ length: 8 }, (_, index) => ({
            page: index + 1,
            url: `https://docs.example.com/q3/${index}`,
          })),
        },
      },
    }),
    sentence: 'Paid.',
  },
  'worst-request': {
    tool: 'request_create',
    arguments: {},
    structured: request({
      request_id: 'rq_w1',
      amount: '99.9999999',
      requester: { address: MUXED, contact_name: LONG_NAME, is_you: false },
      note: 'Dzień dobry! 🎉 Zaległa część za bilety na koncert w Coliseu dos Recreios + parking + kolacja po koncercie (wszystko razem)',
    }),
    sentence: 'Request.',
  },
  'tool-error': {
    tool: 'payment_prepare',
    arguments: PREPARE,
    structured: undefined,
    isError: true,
    sentence: 'No contact named Bobby. Search contacts first, or pass a Stellar address.',
  },
}
