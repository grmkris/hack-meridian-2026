import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  McpClient,
  StreamableHTTPClientTransport,
  generatePaymentId,
  wrapFetchWithPayment,
  wrapMCPClientWithPayment,
  x402HTTPClient,
  type SettleResponse,
} from '../../apps/seller/demo-deps.ts'
import { txFacts } from './lib/chain.ts'
import { ROLES, ROOT, SELLER_URL, key } from './lib/env.ts'
import { payerClient } from './lib/x402.ts'

/**
 * Pays the demo seller once from a classic G account with the stock x402 client, then repeats the same payment id to
 * show the seller's dedup. Writes evidence/seller/pay-<via>-<time>.json.
 *
 *   bun scripts/demo/pay.ts                 HTTP: GET /api/market-brief (BUYER pays)
 *   bun scripts/demo/pay.ts --mcp           MCP: tools/call market_brief on /mcp
 *   bun scripts/demo/pay.ts --id <id> --no-repeat --payer TREASURY --url <seller origin>
 */
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const via = args.includes('--mcp') ? 'mcp' : 'http'
const origin = (flag('--url') ?? SELLER_URL).replace(/\/$/u, '')
const paymentId = flag('--id') ?? `hm26_demo_${generatePaymentId().replace(/^pay_/u, '')}`
const payer = ROLES.find(role => role === (flag('--payer') ?? 'BUYER'))
if (payer === undefined) throw new Error(`--payer must be one of ${ROLES.join(', ')}`)
const repeat = !args.includes('--no-repeat')
const secret = key(payer, false).secret()

interface Attempt {
  readonly attempt: number
  readonly ms: number
  readonly status: number | 'tool-result'
  readonly signed: number
  readonly cache: string | null
  readonly settle: SettleResponse | null
  readonly body: unknown
}

const parse = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return text
  }
}

async function http(attempt: number): Promise<Attempt> {
  const { client, signed } = payerClient(secret, paymentId)
  const started = performance.now()
  const response = await wrapFetchWithPayment(fetch, client)(`${origin}/api/market-brief`)
  const text = await response.text()
  const settle =
    response.headers.get('payment-response') === null
      ? null
      : new x402HTTPClient(client).getPaymentSettleResponse(name => response.headers.get(name))
  return {
    attempt,
    ms: Math.round(performance.now() - started),
    status: response.status,
    signed: signed(),
    cache: response.headers.get('x-payment-cache'),
    settle,
    body: parse(text),
  }
}

async function mcp(attempt: number): Promise<Attempt> {
  const { client, signed } = payerClient(secret, paymentId)
  const mcpClient = new McpClient({ name: 'hm26-demo-buyer', version: '0.1.0' })
  const paying = wrapMCPClientWithPayment(mcpClient, client, { autoPayment: true })
  await paying.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
  const started = performance.now()
  const result = await paying.callTool('market_brief', { topic: 'XLM/USDC' })
  await paying.close()
  const first = result.content[0]
  const firstText: unknown = first !== undefined && first.type === 'text' ? first.text : undefined
  const meta: unknown = Reflect.get(result, '_meta')
  const cache = typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'x-payment-cache') : undefined
  return {
    attempt,
    ms: Math.round(performance.now() - started),
    status: 'tool-result',
    signed: signed(),
    cache: typeof cache === 'string' ? cache : null,
    settle: result.paymentResponse ?? null,
    body: typeof firstText === 'string' ? parse(firstText) : result.content,
  }
}

const attempts: Array<Attempt> = []
for (const n of repeat ? [1, 2] : [1]) {
  const result = via === 'mcp' ? await mcp(n) : await http(n)
  attempts.push(result)
  console.log(
    `${via} attempt ${n}: ${result.status} in ${result.ms} ms, signed=${result.signed}, cache=${result.cache ?? '-'}, settle=${JSON.stringify(result.settle)}`,
  )
}
const tx = attempts[0]?.settle?.transaction
const facts = tx !== undefined && tx !== '' ? await txFacts(tx) : undefined
const record = {
  at: new Date().toISOString(),
  via,
  seller: origin,
  payer: key(payer, false).publicKey(),
  payment_id: paymentId,
  attempts,
  settlement: facts ?? null,
  same_receipt_on_repeat:
    attempts.length === 2
      ? JSON.stringify(attempts[0]?.settle) === JSON.stringify(attempts[1]?.settle) &&
        (via === 'mcp' || attempts[1]?.cache === 'hit')
      : null,
}
const dir = join(ROOT, 'evidence/seller')
mkdirSync(dir, { recursive: true })
const file = join(dir, `pay-${via}-${record.at.replace(/[:.]/gu, '-')}.json`)
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(
  `settlement ${facts?.explorer ?? '(none)'} fee ${facts?.feeCharged ?? '?'} stroops paid by ${facts?.feeAccount ?? '?'}`,
)
console.log(`evidence → ${file}`)
if (facts?.successful !== true) process.exitCode = 1
