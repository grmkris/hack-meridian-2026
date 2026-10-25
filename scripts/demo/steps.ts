import { Stellar } from '../../apps/seller/demo-deps.ts'
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
export type Who = 'alice' | 'bob' | 'carol'

export interface Ctx {
  readonly target: Target
  readonly runId: string
  readonly sellerUrl: string
  readonly relayer: string | undefined
  readonly vars: Map<string, string>
  tools(): ReadonlySet<string>
  /** Onchain checks apply (the target has a chain and the wallet is not a fixture). */
  onchain(): boolean
  markFixture(reason: string): void
  /** What to pass as `payment_prepare.recipient` for a contact: its name, or its address when the wallet lacks it. */
  to(who: Who): string
  setRecipient(who: Who, value: string): void
  seedAddress(who: Who): string | undefined
  connect(): Promise<void>
  call(tool: string, args: Record<string, unknown>): Promise<ToolOutcome>
  browse(actions: ReadonlyArray<Action>): Promise<void>
  pageText(): Promise<string>
  /** An attribute of the first element matching `selector` on the owner's page, if it is there. */
  attribute(selector: string, name: string): Promise<string | undefined>
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
export const isAddress = (value: string) =>
  Stellar.StrKey.isValidEd25519PublicKey(value) || Stellar.StrKey.isValidContract(value)
const needsOwner = (data: unknown) =>
  laneOf(data) === 'owner' || ['requires_approval', 'awaiting_approval'].includes(statusOf(data) ?? '')

export const toStroops = (decimal: string | undefined) => {
  if (decimal === undefined || !/^-?\d+(\.\d+)?$/u.test(decimal)) return undefined
  const [whole = '0', fraction = ''] = decimal.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7))
}
const usdcString = (s: bigint) => `${s / 10_000_000n}.${(s % 10_000_000n).toString().padStart(7, '0')}`

/**
 * Kristjan's demo beats (one number, 18:20 UTC; same on testnet and mainnet; sized to a 10 USDC wallet): allowance 5,
 * x402 0.10 and Alice 2 alone, Bob 5 over the 2.90 left needs the nod, the repeat, 4 over what is left needs the nod,
 * Carol 1 by claim link.
 */
const DINNER = '5'
const CAROL = '1'

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

/** A receipt's transaction landed (fee payer checked by ctx.tx); skipped on a fixture chain. */
async function settled(ctx: Ctx, test: number, label: string, hash: string, payer: 'relayer' | 'facilitator') {
  if (!ctx.onchain()) return ctx.skip(test, `${label}: fixture chain, ${hash.slice(0, 8)}… is not on a ledger`)
  const facts = await ctx.tx(label, hash, payer)
  ctx.check(
    test,
    facts?.successful === true,
    `${label}: ${hash.slice(0, 8)}… ${facts?.successful === true ? 'successful onchain' : 'not found onchain'}`,
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
    title: 'Connect the AI app: DCR + PKCE, consent page, passkey, allowance',
    tests: [],
    needs: [],
    run: async ctx => {
      await ctx.connect()
      ctx.check(null, ctx.tools().has('wallet_overview'), `tools/list → ${[...ctx.tools()].join(', ')}`)
    },
  },
  {
    id: 's2',
    title: 'Allowance installed onchain: amount and expiry for this AI app',
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
      else if (contract !== undefined)
        ctx.markFixture(`wallet ${contract.slice(0, 12)}… is not a contract id (fixture chain)`)
      const rule = str(pick(overview.data, 'grant.rule_id'))
      if (rule !== undefined) ctx.vars.set('rule_id', rule)
      if (ctx.onchain() && contract !== undefined && rule !== undefined)
        ctx.check(
          null,
          (await ctx.ruleLive(contract, Number(rule))) === true,
          `rule ${rule} live onchain on ${contract.slice(0, 6)}…`,
        )
      if (ctx.onchain() && ctx.target.features.has('fund') && contract !== undefined && ctx.target.fundTo !== undefined)
        await ctx.fundWallet(contract, ctx.target.fundTo)
      if (ctx.tools().has('contacts_search'))
        for (const who of ['alice', 'bob', 'carol'] as const) {
          const name = ctx.to(who)
          const found = await ctx.call('contacts_search', { query: name })
          const contacts = pick(found.data, 'contacts')
          const saved =
            Array.isArray(contacts) &&
            contacts.some(c => (str(pick(c, 'name')) ?? '').toLowerCase() === name.toLowerCase())
          const address = ctx.seedAddress(who)
          ctx.check(
            null,
            saved,
            `contact ${name} ${saved ? 'saved in the new wallet' : `missing; paying ${address ?? '?'} directly`}`,
          )
          if (!saved && address !== undefined) ctx.setRecipient(who, address)
        }
    },
  },
  {
    id: 's3',
    title: 'wallet_overview: wallet balance and allowance are two numbers',
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
      if (ctx.onchain())
        ctx.check(1, (str(pick(out.data, 'body')) ?? '').includes('market brief'), 'body is the seller’s market brief')
      else ctx.skip(1, 'fixture chain: the body is the fixture’s, not the seller’s')
      const settlement = receiptTx(out.data)
      const pull = str(pick(out.data, 'receipt.pull_tx_hash'))
      if (settlement === undefined) ctx.check(7, false, 'no receipt')
      else await settled(ctx, 1, 'x402 settlement (receipt only after it landed)', settlement, 'facilitator')
      if (pull !== undefined) await settled(ctx, 7, 'x402 pull from the wallet into the pocket', pull, 'relayer')
      const after = remaining(out.data)
      allowanceMoved(ctx, 1, before, after, -1_000_000n, 'x402 purchase consumed the grant')
      if (after !== undefined) ctx.vars.set('remaining', after)
    },
  },
  {
    id: 's5',
    title: 'Send Alice 2 USDC inside the allowance: payment_prepare → payment_execute',
    tests: [7, 9],
    needs: ['autonomous'],
    run: async ctx => {
      const before = need(ctx, 'remaining')
      const prepared = await ctx.call('payment_prepare', {
        recipient: ctx.to('alice'),
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
      if (tx !== undefined) await settled(ctx, 7, 'payment to Alice inside the allowance', tx, 'relayer')
      await credited(ctx, 7, alice, aliceBefore, 20_000_000n, 'Alice received 2')
      const after = remaining(done)
      allowanceMoved(ctx, 7, before, after, -20_000_000n, 'delegated payment consumed the grant')
      if (after !== undefined) ctx.vars.set('remaining', after)
    },
  },
  {
    id: 's6',
    title: 'Ask for 5 USDC to Bob for dinner (2.90 left) → needs your nod (approval link)',
    tests: [4, 7],
    needs: [],
    run: async ctx => {
      const before = ctx.vars.get('remaining')
      const args = {
        recipient: ctx.to('bob'),
        amount: DINNER,
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
    title: 'Owner opens the link, sees recipient and amount, nods with the passkey; the AI app polls',
    tests: [4, 7, 9],
    needs: [],
    run: async ctx => {
      const id = need(ctx, 'dinner_id')
      const bob = ctx.vars.get('bob')
      const bobBefore = bob !== undefined && ctx.onchain() ? await ctx.usdcOf(bob) : undefined
      const opened = await ctx.call('payment_status', { payment_id: id })
      await ctx.browse(ctx.target.approve)
      const page = await ctx.pageText()
      const asked = ctx.to('bob')
      const name = isAddress(asked) ? undefined : (asked.split(' ')[0] ?? asked)
      ctx.check(
        4,
        page.includes(DINNER) &&
          (name === undefined || page.includes(name)) &&
          (bob === undefined || page.includes(bob)),
        `approval page shows ${name ?? ''}${bob !== undefined ? ` (${bob.slice(0, 6)}…)` : ''} and ${DINNER} USDC`,
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
      if (tx !== undefined) await settled(ctx, 7, 'payment to Bob approved with the passkey', tx, 'relayer')
      if (ctx.onchain())
        await credited(ctx, 4, bob, bobBefore, toStroops(DINNER) ?? 0n, `Bob received exactly ${DINNER}`)
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
      const bobBefore = bob !== undefined && ctx.onchain() ? await ctx.usdcOf(bob) : undefined
      const again = await ctx.call('payment_prepare', {
        recipient: ctx.to('bob'),
        amount: DINNER,
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
    title: 'Ask for 4 USDC with 2.90 left → needs your nod, not an onchain revert',
    tests: [2],
    needs: [],
    run: async ctx => {
      const before = ctx.vars.get('remaining')
      // 4 USDC is above the 2.90 left after s4 + s5; if an earlier payment did not land, ask for 1 more than is left
      const left = toStroops(before)
      const ask = left !== undefined && left >= 40_000_000n ? usdcString(left + 10_000_000n) : '4'
      if (ask !== '4') ctx.note(`allowance ${before} is not below 4 (an earlier step did not spend): asking ${ask}`)
      const out = await ctx.call('payment_prepare', {
        recipient: ctx.to('alice'),
        amount: ask,
        reason: 'more than the allowance left',
        idempotency_key: key(ctx, 'alice-over'),
      })
      ctx.check(
        2,
        needsOwner(out.data) && approvalUrl(out.data) !== undefined,
        `${ask} > ${before ?? '?'} → lane ${laneOf(out.data) ?? '-'}, status ${statusOf(out.data)}`,
      )
      if (ctx.tools().has('payment_execute')) {
        const id = paymentId(out.data)
        if (id !== undefined) {
          const refused = await ctx.call('payment_execute', {
            payment_id: id,
            idempotency_key: key(ctx, 'alice-over-exec'),
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
    title: 'Send Carol 1 USDC: trustline required → your nod → claim link → trust + transfer in one transaction',
    tests: [8, 9],
    needs: ['claim'],
    run: async ctx => {
      const prepared = await ctx.call('payment_prepare', {
        recipient: ctx.to('carol'),
        amount: CAROL,
        reason: 'claim-link demo',
        idempotency_key: key(ctx, 'carol'),
      })
      const carol = str(pick(prepared.data, 'recipient.address'))
      const readiness = str(pick(prepared.data, 'recipient.readiness'))
      ctx.check(8, readiness === 'trustline_required', `Carol readiness ${readiness}`)
      if (carol !== undefined && ctx.onchain())
        ctx.check(8, (await ctx.trustline(carol)) === false, `${carol.slice(0, 6)}… has no USDC trustline before`)
      const id = paymentId(prepared.data)
      if (id === undefined) throw new Error('payment_prepare returned no payment_id')
      // The owner nods first (claim links open once the payment is approved), then Carol accepts on the claim page.
      const approval = str(pick(prepared.data, 'approval_url'))
      if (needsOwner(prepared.data) && approval !== undefined) {
        ctx.vars.set('approval_url', approval)
        await ctx.browse(ctx.target.approve)
      }
      const claimUrl =
        str(pick(prepared.data, 'claim_url')) ??
        str(pick((await ctx.call('payment_status', { payment_id: id })).data, 'claim_url')) ??
        `${ctx.target.base}/claim/${id}`
      ctx.vars.set('claim_url', claimUrl)
      await ctx.browse(ctx.target.claim)
      const done = await ctx.waitConfirmed(id, 120_000)
      const tx = receiptTx(done)
      ctx.check(
        8,
        statusOf(done) === 'confirmed' && tx !== undefined,
        `payment_status ${statusOf(done)}, receipt ${tx?.slice(0, 8)}`,
      )
      if (tx !== undefined) await settled(ctx, 8, 'claim: trustline + payment in one transaction', tx, 'relayer')
      if (carol !== undefined && ctx.onchain()) {
        ctx.check(8, (await ctx.trustline(carol)) === true, 'Carol now has the trustline')
        ctx.check(8, (await ctx.usdcOf(carol)) === toStroops(CAROL), `Carol holds ${CAROL} USDC`)
        ctx.vars.set('carol', carol)
      }
    },
  },
  {
    id: 's9',
    title: 'Owner revokes the AI app on the site → its next payment is refused, allowance gone onchain',
    tests: [6],
    needs: [],
    run: async ctx => {
      need(ctx, 'connection_id')
      await ctx.browse(ctx.target.revoke)
      const next = await ctx.call('payment_prepare', {
        recipient: ctx.to('alice'),
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
      // the revoke page links the rule-removal and pocket-sweep transactions (A1 7036c72)
      for (const [testid, label] of [
        ['rule-removal-tx', 'allowance removed from the account onchain'],
        ['pocket-sweep-tx', 'pocket swept back to the wallet'],
      ] as const) {
        const href = await ctx.attribute(`[data-testid="${testid}"]`, 'href')
        const hash = href === undefined ? undefined : /\/tx\/([0-9a-f]{64})/u.exec(href)?.[1]
        if (hash !== undefined) await settled(ctx, 6, label, hash, 'relayer')
        else ctx.note(`${testid}: not on the page`)
      }
      const contract = ctx.vars.get('contract_id')
      const rule = ctx.vars.get('rule_id')
      if (ctx.onchain() && contract !== undefined && rule !== undefined) {
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
    title: 'Fee audit: Nod paid every network fee, the owner account holds no XLM',
    tests: [3, 9],
    needs: [],
    run: async ctx => {
      ctx.ref(
        3,
        'forced over-limit transfer signed by the connection key: rejected onchain #3221 in S1 (3daf4b00…, docs/spikes/s1.md) and refused at enforce simulation in S5; not reachable through MCP by design',
      )
      const contract = ctx.vars.get('contract_id')
      if (contract === undefined || !ctx.onchain()) return ctx.skip(9, 'no onchain wallet on this target')
      const xlm = await ctx.xlmOf(contract)
      ctx.check(
        9,
        xlm === 0n,
        `owner account ${contract.slice(0, 6)}… holds ${xlm === undefined ? '?' : usdcString(xlm)} XLM`,
      )
    },
  },
]
