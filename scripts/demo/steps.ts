import type { Action } from './lib/actions.ts'
import type { TxFacts } from './lib/chain.ts'
import { pick, str } from './lib/json.ts'
import type { Target } from './targets.ts'

/**
 * The nine demo steps of docs/SPEC.md plus the claim link, as data: each step names the acceptance tests (1–9) it
 * produces evidence for and the features it needs. The runner (rehearse.ts) supplies the context.
 */
export interface ToolOutcome {
  readonly ok: boolean
  readonly isError: boolean
  /** structuredContent, or the JSON in the text content */
  readonly data: unknown
  readonly text: string
  readonly error?: string
}

export type Feature = Target['features'] extends ReadonlySet<infer F> ? F : never
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'ref'

export interface Ctx {
  readonly target: Target
  readonly runId: string
  readonly sellerUrl: string
  readonly relayer: string | undefined
  readonly vars: Map<string, string>
  tools(): ReadonlySet<string>
  connect(): Promise<void>
  call(tool: string, args: Record<string, unknown>): Promise<ToolOutcome>
  browse(actions: ReadonlyArray<Action>): Promise<void>
  pageText(): Promise<string>
  check(test: number | null, ok: boolean, detail: string): void
  skip(test: number | null, detail: string): void
  ref(test: number, detail: string): void
  /** Looks a hash up on Horizon and records it with a label (feePayer: who should have paid the fee). */
  tx(label: string, hash: string, feePayer: 'relayer' | 'facilitator' | 'any'): Promise<TxFacts | undefined>
  /** USDC (stroops) of any address, read from the SAC; undefined off-chain. */
  usdcOf(address: string): Promise<bigint | undefined>
  xlmOf(address: string): Promise<bigint | undefined>
  trustline(address: string): Promise<boolean | undefined>
  fundWallet(contractId: string, toUsdc: number): Promise<void>
  /** Polls payment_status until `confirmed` (or a final failure); returns the last view. */
  waitConfirmed(paymentId: string, timeoutMs?: number): Promise<unknown>
  /** True when a policy rule exists onchain for the account (get_spending_limit_data answers). */
  ruleLive(contractId: string, ruleId: number): Promise<boolean | undefined>
  note(text: string): void
}

export interface Step {
  readonly id: string
  readonly title: string
  readonly tests: ReadonlyArray<number>
  readonly needs: ReadonlyArray<Feature>
  readonly run: (ctx: Ctx) => Promise<void>
}

// ---------------------------------------------------------------- reading tool results (stub and service shapes)
export const remaining = (data: unknown) => str(pick(data, 'grant_remaining', 'grant.remaining', 'allowance.remaining'))
export const paymentId = (data: unknown) => str(pick(data, 'payment_id', 'intent.payment_id'))
export const statusOf = (data: unknown) => str(pick(data, 'status'))
export const laneOf = (data: unknown) => str(pick(data, 'lane'))
export const approvalUrl = (data: unknown) => str(pick(data, 'approval_url', 'claim_url'))
export const receiptTx = (data: unknown) => str(pick(data, 'receipt.tx_hash', 'receipt.transaction'))
export const isAddress = (value: string) => /^[GC][A-Z2-7]{55}$/u.test(value)
const needsOwner = (data: unknown) =>
  laneOf(data) === 'owner' || ['requires_approval', 'awaiting_approval'].includes(statusOf(data) ?? '')

export const toStroops = (decimal: string | undefined) => {
  if (decimal === undefined || !/^-?\d+(\.\d+)?$/u.test(decimal)) return undefined
  const [whole = '0', fraction = ''] = decimal.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7))
}
const usdcString = (s: bigint) => `${s / 10_000_000n}.${(s % 10_000_000n).toString().padStart(7, '0')}`

const key = (ctx: Ctx, name: string) => `rh-${ctx.runId}-${name}`
const need = (ctx: Ctx, name: string) => {
  const value = ctx.vars.get(name)
  if (value === undefined) throw new Error(`needs ${name} from an earlier step`)
  return value
}

/** Asserts the grant's remaining allowance moved by `delta` (USDC, negative = spent). */
function allowanceMoved(
  ctx: Ctx,
  test: number,
  before: string | undefined,
  after: string | undefined,
  delta: bigint,
  what: string,
) {
  const b = toStroops(before)
  const a = toStroops(after)
  if (b === undefined || a === undefined)
    return ctx.check(test, false, `${what}: grant_remaining unreadable (${before} → ${after})`)
  ctx.check(
    test,
    a - b === delta,
    `${what}: allowance ${before} → ${after} (expected ${delta === 0n ? 'unchanged' : usdcString(-delta) + ' less'})`,
  )
}

/** The recipient's onchain USDC moved by exactly `amount` (the approval bound recipient and amount). */
async function credited(
  ctx: Ctx,
  test: number,
  address: string | undefined,
  before: bigint | undefined,
  amount: bigint,
  what: string,
) {
  if (address === undefined || !isAddress(address) || before === undefined)
    return ctx.skip(test, `${what}: recipient balance not readable`)
  const after = await ctx.usdcOf(address)
  ctx.check(
    test,
    after !== undefined && after - before === amount,
    `${what}: ${address.slice(0, 6)}… USDC ${usdcString(before)} → ${after === undefined ? '?' : usdcString(after)}`,
  )
}

export const STEPS: ReadonlyArray<Step> = [
  {
    id: 's1',
    title: 'Connect: DCR + PKCE, consent page, passkey, allowance',
    tests: [],
    needs: [],
    run: async ctx => {
      await ctx.connect()
      ctx.check(null, ctx.tools().has('wallet_overview'), `tools/list → ${[...ctx.tools()].join(', ')}`)
    },
  },
  {
    id: 's2',
    title: 'Grant installed: allowance and expiry on the connection',
    tests: [],
    needs: [],
    run: async ctx => {
      const overview = await ctx.call('wallet_overview', { idempotency_key: key(ctx, 'overview-0') })
      const total = str(pick(overview.data, 'grant.total', 'allowance.total'))
      ctx.check(
        null,
        toStroops(total) === toStroops(ctx.target.allowance),
        `grant total ${total} = consent ${ctx.target.allowance}`,
      )
      const connection = str(pick(overview.data, 'connection.id'))
      if (connection !== undefined) ctx.vars.set('connection_id', connection)
      const contract = str(pick(overview.data, 'wallet.contract_id'))
      if (contract !== undefined && contract.startsWith('C') && isAddress(contract))
        ctx.vars.set('contract_id', contract)
      const rule = str(pick(overview.data, 'grant.rule_id'))
      if (rule !== undefined) ctx.vars.set('rule_id', rule)
      if (ctx.target.features.has('onchain') && contract !== undefined && rule !== undefined)
        ctx.check(
          null,
          (await ctx.ruleLive(contract, Number(rule))) === true,
          `rule ${rule} live onchain on ${contract.slice(0, 6)}…`,
        )
      if (ctx.target.features.has('fund') && contract !== undefined && ctx.target.fundTo !== undefined)
        await ctx.fundWallet(contract, ctx.target.fundTo)
    },
  },
  {
    id: 's3',
    title: 'wallet_overview: balance and allowance are two numbers',
    tests: [],
    needs: [],
    run: async ctx => {
      const overview = await ctx.call('wallet_overview', { idempotency_key: key(ctx, 'overview-1') })
      const balance = str(pick(overview.data, 'balances.usdc', 'balance.amount'))
      const left = remaining(overview.data)
      const expiry = str(pick(overview.data, 'grant.valid_until', 'allowance.valid_until'))
      ctx.check(
        null,
        balance !== undefined && left !== undefined,
        `balance ${balance} USDC, allowance ${left} remaining until ${expiry}`,
      )
      if (left !== undefined) ctx.vars.set('remaining', left)
    },
  },
  {
    id: 's4',
    title: 'paid_resource_fetch: buy the market brief for 0.10 over x402',
    tests: [1, 7, 9],
    needs: ['x402'],
    run: async ctx => {
      const before = need(ctx, 'remaining')
      const out = await ctx.call('paid_resource_fetch', {
        url: `${ctx.sellerUrl}/api/market-brief`,
        max_amount: '0.10',
        reason: 'market brief for the demo',
        idempotency_key: key(ctx, 'brief'),
      })
      ctx.check(
        1,
        statusOf(out.data) === 'paid',
        `status ${statusOf(out.data)}, http ${str(pick(out.data, 'http_status'))}`,
      )
      ctx.check(1, (str(pick(out.data, 'body')) ?? '').includes('market brief'), 'body is the seller’s market brief')
      const settlement = receiptTx(out.data)
      const pull = str(pick(out.data, 'receipt.pull_tx_hash'))
      if (settlement === undefined) ctx.check(7, false, 'no receipt')
      else {
        const facts = await ctx.tx('x402 settlement', settlement, 'facilitator')
        ctx.check(
          7,
          facts?.successful === true,
          `receipt only after settlement: ${settlement.slice(0, 8)}… ${facts?.successful === true ? 'successful onchain' : 'not found'}`,
        )
        ctx.check(1, facts?.successful === true, 'the 0.10 settled onchain')
      }
      if (pull !== undefined) await ctx.tx('x402 pocket pull', pull, 'relayer')
      const after = remaining(out.data)
      allowanceMoved(ctx, 1, before, after, -1_000_000n, 'x402 purchase consumed the grant')
      if (after !== undefined) ctx.vars.set('remaining', after)
    },
  },
  {
    id: 's5',
    title: 'Send Alice 2 USDC: payment_prepare → payment_execute (autonomous lane)',
    tests: [7, 9],
    needs: ['autonomous'],
    run: async ctx => {
      const before = need(ctx, 'remaining')
      const prepared = await ctx.call('payment_prepare', {
        recipient: ctx.target.recipients.alice,
        amount: '2',
        reason: 'demo: pay a saved contact',
        idempotency_key: key(ctx, 'alice-2'),
      })
      ctx.check(null, laneOf(prepared.data) === 'autonomous', `lane ${laneOf(prepared.data)}`)
      const id = paymentId(prepared.data)
      if (id === undefined) throw new Error('payment_prepare returned no payment_id')
      const alice = str(pick(prepared.data, 'recipient.address'))
      const aliceBefore = alice !== undefined ? await ctx.usdcOf(alice) : undefined
      await ctx.call('payment_execute', { payment_id: id, idempotency_key: key(ctx, 'alice-2-exec') })
      const done = await ctx.waitConfirmed(id)
      const tx = receiptTx(done)
      ctx.check(
        7,
        statusOf(done) === 'confirmed' && tx !== undefined,
        `payment_status ${statusOf(done)} with receipt ${tx?.slice(0, 8)}`,
      )
      if (tx !== undefined) {
        const facts = await ctx.tx('delegated payment to Alice', tx, 'relayer')
        ctx.check(7, facts?.successful === true, 'receipt tx successful onchain')
      }
      await credited(ctx, 7, alice, aliceBefore, 20_000_000n, 'Alice received 2')
      const after = remaining(done)
      allowanceMoved(ctx, 7, before, after, -20_000_000n, 'delegated payment consumed the grant')
      if (after !== undefined) ctx.vars.set('remaining', after)
    },
  },
  {
    id: 's6',
    title: 'Ask for 100 USDC to Bob for dinner → requires_approval + link',
    tests: [4, 7],
    needs: [],
    run: async ctx => {
      const before = ctx.vars.get('remaining')
      const args = {
        recipient: ctx.target.recipients.bob,
        amount: '100',
        reason: 'dinner',
        idempotency_key: key(ctx, 'dinner'),
      }
      const prepared = await ctx.call('payment_prepare', args)
      const url = approvalUrl(prepared.data)
      ctx.check(
        4,
        needsOwner(prepared.data) && url !== undefined,
        `lane ${laneOf(prepared.data) ?? '-'}, status ${statusOf(prepared.data)}, approval_url ${url}`,
      )
      ctx.check(4, prepared.text.includes(url ?? '\u0000'), 'the approval link is in the tool result text too')
      const id = paymentId(prepared.data)
      if (id === undefined || url === undefined) throw new Error('no payment_id / approval_url')
      ctx.vars.set('dinner_id', id)
      ctx.vars.set('approval_url', url)
      const bob = str(pick(prepared.data, 'recipient.address'))
      if (bob !== undefined) ctx.vars.set('bob', bob)
      const status = await ctx.call('payment_status', { payment_id: id })
      ctx.check(
        7,
        statusOf(status.data) === 'awaiting_approval' && receiptTx(status.data) === undefined,
        `before approval: ${statusOf(status.data)}, no receipt`,
      )
      if (before !== undefined)
        allowanceMoved(
          ctx,
          4,
          before,
          remaining(prepared.data) ?? remaining(status.data),
          0n,
          'owner-lane request reserved nothing',
        )
    },
  },
  {
    id: 's7',
    title: 'Owner opens the link, sees recipient and amount, approves with the passkey; agent polls',
    tests: [4, 7, 9],
    needs: [],
    run: async ctx => {
      const id = need(ctx, 'dinner_id')
      const bob = ctx.vars.get('bob')
      const bobBefore = bob !== undefined && ctx.target.features.has('onchain') ? await ctx.usdcOf(bob) : undefined
      const opened = await ctx.call('payment_status', { payment_id: id })
      await ctx.browse(ctx.target.approve)
      const page = await ctx.pageText()
      const shown = ctx.target.recipients.bob.split(' ')[0] ?? 'Bob'
      ctx.check(
        4,
        page.includes('100') && page.includes(shown) && (bob === undefined || page.includes(bob)),
        `approval page shows ${shown}${bob !== undefined ? ` (${bob.slice(0, 6)}…)` : ''} and 100 USDC`,
      )
      ctx.check(
        7,
        statusOf(opened.data) === 'awaiting_approval',
        'opening the link had no side effect before approving',
      )
      const done = await ctx.waitConfirmed(id, 120_000)
      const tx = receiptTx(done)
      ctx.check(
        7,
        statusOf(done) === 'confirmed' && tx !== undefined,
        `payment_status ${statusOf(done)}, receipt ${tx?.slice(0, 8)}`,
      )
      ctx.vars.set('dinner_receipt', tx ?? '')
      if (ctx.target.features.has('onchain') && tx !== undefined) {
        const facts = await ctx.tx('owner-approved payment to Bob', tx, 'relayer')
        ctx.check(7, facts?.successful === true, 'receipt tx successful onchain')
        await credited(ctx, 4, bob, bobBefore, 1_000_000_000n, 'Bob received exactly 100')
      } else ctx.skip(7, 'stub: receipts are fake, nothing onchain to check')
      const before = ctx.vars.get('remaining')
      if (before !== undefined)
        allowanceMoved(ctx, 4, before, remaining(done), 0n, 'owner lane did not consume the grant')
    },
  },
  {
    id: 's8a',
    title: 'Same request again (same idempotency key) → same receipt, no second payment',
    tests: [5],
    needs: [],
    run: async ctx => {
      const bob = ctx.vars.get('bob')
      const bobBefore = bob !== undefined && ctx.target.features.has('onchain') ? await ctx.usdcOf(bob) : undefined
      const again = await ctx.call('payment_prepare', {
        recipient: ctx.target.recipients.bob,
        amount: '100',
        reason: 'dinner',
        idempotency_key: key(ctx, 'dinner'),
      })
      ctx.check(5, paymentId(again.data) === need(ctx, 'dinner_id'), `same payment_id ${paymentId(again.data)}`)
      const receipt = ctx.vars.get('dinner_receipt')
      if (receipt !== undefined && receipt !== '')
        ctx.check(
          5,
          receiptTx(again.data) === receipt || statusOf(again.data) === 'confirmed',
          `same receipt ${receipt.slice(0, 8)}…`,
        )
      if (bobBefore !== undefined && bob !== undefined) {
        await new Promise(resolve => setTimeout(resolve, 6_000))
        await credited(ctx, 5, bob, bobBefore, 0n, 'no second payment to Bob')
      }
    },
  },
  {
    id: 's8b',
    title: 'Ask for 4 USDC with 2.90 left → owner lane, not an onchain revert',
    tests: [2],
    needs: [],
    run: async ctx => {
      const before = ctx.vars.get('remaining')
      const out = await ctx.call('payment_prepare', {
        recipient: ctx.target.recipients.alice,
        amount: '4',
        reason: 'more than the allowance left',
        idempotency_key: key(ctx, 'alice-4'),
      })
      ctx.check(
        2,
        needsOwner(out.data) && approvalUrl(out.data) !== undefined,
        `4 > ${before ?? '?'} → lane ${laneOf(out.data) ?? '-'}, status ${statusOf(out.data)}`,
      )
      if (ctx.tools().has('payment_execute')) {
        const id = paymentId(out.data)
        if (id !== undefined) {
          const refused = await ctx.call('payment_execute', {
            payment_id: id,
            idempotency_key: key(ctx, 'alice-4-exec'),
          })
          ctx.check(
            2,
            refused.isError || !refused.ok || statusOf(refused.data) !== 'confirmed',
            'payment_execute refuses an owner-lane intent (never signed with the connection key)',
          )
        }
      }
      if (before !== undefined) allowanceMoved(ctx, 2, before, remaining(out.data), 0n, 'nothing reserved or spent')
    },
  },
  {
    id: 's10',
    title: 'Send Carol 10 USDC: trustline required → claim link → trust + transfer in one transaction',
    tests: [8, 9],
    needs: ['claim'],
    run: async ctx => {
      const prepared = await ctx.call('payment_prepare', {
        recipient: ctx.target.recipients.carol,
        amount: '10',
        reason: 'claim-link demo',
        idempotency_key: key(ctx, 'carol-10'),
      })
      const carol = str(pick(prepared.data, 'recipient.address'))
      const readiness = str(pick(prepared.data, 'recipient.readiness'))
      ctx.check(8, readiness === 'trustline_required', `Carol readiness ${readiness}`)
      if (carol !== undefined)
        ctx.check(8, (await ctx.trustline(carol)) === false, `${carol.slice(0, 6)}… has no USDC trustline before`)
      const id = paymentId(prepared.data)
      const url = str(pick(prepared.data, 'claim_url', 'approval_url'))
      if (id === undefined || url === undefined) throw new Error('no payment_id / claim link')
      ctx.vars.set('claim_url', url)
      ctx.vars.set('approval_url', url)
      await ctx.browse(ctx.target.claim)
      const mid = await ctx.call('payment_status', { payment_id: id })
      if (statusOf(mid.data) === 'awaiting_approval' && approvalUrl(mid.data) !== undefined) {
        ctx.vars.set('approval_url', approvalUrl(mid.data) ?? url)
        await ctx.browse(ctx.target.approve)
      }
      const done = await ctx.waitConfirmed(id, 120_000)
      const tx = receiptTx(done)
      ctx.check(
        8,
        statusOf(done) === 'confirmed' && tx !== undefined,
        `payment_status ${statusOf(done)}, receipt ${tx?.slice(0, 8)}`,
      )
      if (tx !== undefined) await ctx.tx('claim: trust + transfer', tx, 'relayer')
      if (carol !== undefined) {
        ctx.check(8, (await ctx.trustline(carol)) === true, 'Carol now has the trustline')
        ctx.check(8, (await ctx.usdcOf(carol)) === 100_000_000n, 'Carol holds 10 USDC')
        ctx.vars.set('carol', carol)
      }
    },
  },
  {
    id: 's9',
    title: 'Owner revokes the connection on the site → next delegated payment refused, rule gone onchain',
    tests: [6],
    needs: [],
    run: async ctx => {
      need(ctx, 'connection_id')
      await ctx.browse(ctx.target.revoke)
      const next = await ctx.call('payment_prepare', {
        recipient: ctx.target.recipients.alice,
        amount: '0.01',
        reason: 'after revoke',
        idempotency_key: key(ctx, 'after-revoke'),
      })
      let refused = !next.ok || next.isError
      if (!refused && ctx.tools().has('payment_execute')) {
        const id = paymentId(next.data)
        const executed =
          id === undefined
            ? undefined
            : await ctx.call('payment_execute', { payment_id: id, idempotency_key: key(ctx, 'after-revoke-exec') })
        refused = executed === undefined || !executed.ok || executed.isError || statusOf(executed.data) !== 'confirmed'
      }
      ctx.check(6, refused, `next delegated payment after revoke: ${next.error ?? statusOf(next.data) ?? 'refused'}`)
      const contract = ctx.vars.get('contract_id')
      const rule = ctx.vars.get('rule_id')
      if (ctx.target.features.has('onchain') && contract !== undefined && rule !== undefined) {
        let live = await ctx.ruleLive(contract, Number(rule))
        for (let i = 0; i < 12 && live === true; i++) {
          await new Promise(resolve => setTimeout(resolve, 5_000))
          live = await ctx.ruleLive(contract, Number(rule))
        }
        ctx.check(6, live === false, `rule ${rule} ${live === false ? 'removed' : 'still live'} onchain`)
      } else ctx.skip(6, 'onchain rule removal not checkable on this target')
    },
  },
  {
    id: 's11',
    title: 'Fee audit: the relayer paid every fee, the owner account holds no XLM',
    tests: [3, 9],
    needs: [],
    run: async ctx => {
      ctx.ref(
        3,
        'forced over-limit transfer signed by the connection key: rejected onchain #3221 in S1 (3daf4b00…, docs/spikes/s1.md) and refused at enforce simulation in S5; not reachable through MCP by design',
      )
      const contract = ctx.vars.get('contract_id')
      if (contract === undefined || !ctx.target.features.has('onchain'))
        return ctx.skip(9, 'no onchain wallet on this target')
      const xlm = await ctx.xlmOf(contract)
      ctx.check(
        9,
        xlm === 0n,
        `owner account ${contract.slice(0, 6)}… holds ${xlm === undefined ? '?' : usdcString(xlm)} XLM`,
      )
    },
  },
]
