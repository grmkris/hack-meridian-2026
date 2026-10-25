import { Cause, Effect, Ref } from 'effect'

import { Chain, fromStroops, type ReceiptView, toStroops } from '@hm/protocol'

import { nowIso } from '../clock.ts'
import { Network } from '../network.ts'
import type { AppRuntime } from '../runtime.ts'
import { connectionById, grantOfConnection } from '../store.ts'
import {
  asToolError,
  connectionGrantRevoke,
  paidResourceFetch,
  paymentExecute,
  paymentPrepare,
  paymentStatus,
  walletOverview,
} from '../tools.ts'
import { type Site, WalletSettings } from '../wallet-settings.ts'
import {
  demoPasskey,
  demoWallet,
  sampleConnection,
  SetupError,
  syncContacts,
  toolContext,
  topUp,
} from './demo-wallet.ts'
import { MARKET_BRIEF_URL, SAMPLE_AMOUNTS, type SampleLine, type SampleRun } from './model.ts'
import { acceptClaimAsDemoRecipient, type DemoOwner, nod, removeRule } from './owner-pages.ts'

/**
 * One sample run: the nine demo steps of docs/SPEC.md, executed by the server against Nod's demo wallet. The agent's
 * calls are the MCP tool handlers themselves (tools.ts, the functions /mcp registers), under a ToolContext built the
 * way /mcp builds one; the owner's nods are the approval, claim and revoke page handlers (routes.ts) answered by the
 * demo owner's soft passkey. Each step becomes one or two log lines; a failed step is logged and the run goes on.
 */

export interface SampleInput {
  readonly id: string
  readonly site: Site
  /** VAULT_KEY, which seals the demo owner's passkey. */
  readonly secret: string
}

const messageOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error)

type Outcome = Pick<SampleLine, 'state' | 'amount' | 'fee' | 'detail' | 'links'>

const feeOf = (receipt: ReceiptView | null): string | null =>
  receipt === null
    ? null
    : receipt.fee_paid_by === 'relayer'
      ? `Nod paid ${receipt.fee_xlm} XLM`
      : `the facilitator paid ${receipt.fee_xlm} XLM`

/** Idempotency keys are per run: a repeat inside the run hits the same intent, the next run starts fresh. */
const keyOf = (runId: string, name: string) => `sample-${runId}-${name}`

export const sampleProgram = (runtime: AppRuntime, input: SampleInput, report: (run: SampleRun) => Promise<void>) =>
  Effect.gen(function* () {
    const createdAt = yield* nowIso
    const lines = yield* Ref.make<ReadonlyArray<SampleLine>>([])
    const snapshot = (status: SampleRun['status'], error: string | null) =>
      Effect.gen(function* () {
        const run: SampleRun = {
          id: input.id,
          status,
          created_at: createdAt,
          finished_at: status === 'running' ? null : yield* nowIso,
          lines: yield* Ref.get(lines),
          error,
        }
        yield* Effect.promise(() => report(run))
        return run
      })
    const say = (line: SampleLine) =>
      Ref.update(lines, all => [...all, line]).pipe(Effect.andThen(snapshot('running', null)), Effect.asVoid)
    /** A step: shown as running at once, then replaced by its outcome; a failure is logged, never thrown. */
    const step = <E, R>(
      id: string,
      title: string,
      tool: string | null,
      body: Effect.Effect<Outcome, E, R>,
    ): Effect.Effect<Outcome, never, R> =>
      Effect.gen(function* () {
        const index = (yield* Ref.get(lines)).length
        yield* say({ step: id, title, tool, state: 'running', amount: null, fee: null, detail: '…', links: [] })
        const outcome = yield* body.pipe(
          Effect.catchCause(cause =>
            Effect.succeed<Outcome>({
              state: 'failed',
              amount: null,
              fee: null,
              detail: messageOf(Cause.squash(cause)),
              links: [],
            }),
          ),
        )
        yield* Ref.update(lines, all =>
          all.map((line, at) => (at === index ? { step: id, title, tool, ...outcome } : line)),
        )
        yield* snapshot('running', null)
        return outcome
      })

    const network = yield* Network
    const chain = yield* Chain
    const settings = yield* WalletSettings
    const tx = (hash: string) => `${network.explorerBase}/tx/${hash}`

    // Setup: the demo owner, its wallet and contacts, a fresh allowance, enough USDC.
    const setup = yield* Effect.gen(function* () {
      const passkey = yield* demoPasskey(input.site, input.secret)
      const { wallet, token } = yield* demoWallet(input.site, passkey, say)
      const owner: DemoOwner = { runtime, site: input.site, token, passkey }
      yield* syncContacts(wallet.owner_id)
      const connectionId = yield* sampleConnection(owner, wallet, say)
      yield* topUp(wallet, say)
      const connection = yield* connectionById(connectionId)
      const grant = yield* grantOfConnection(connectionId)
      if (connection === undefined || grant === undefined)
        return yield* new SetupError({ message: 'the sample connection vanished' })
      return { wallet, owner, ctx: yield* toolContext(wallet, connection, grant, input.site.origin) }
    }).pipe(Effect.result)
    if (setup._tag === 'Failure') {
      yield* say({
        step: '0',
        title: 'The sample could not start',
        tool: null,
        state: 'failed',
        amount: null,
        fee: null,
        detail: messageOf(setup.failure),
        links: [],
      })
      return yield* snapshot('failed', messageOf(setup.failure))
    }
    const { wallet, owner, ctx } = setup.success
    const walletUrl = `${network.explorerBase}/contract/${wallet.contract_id}`

    // 1. wallet_overview
    yield* step(
      '1',
      'The agent looks at the wallet: two numbers that never blur',
      'wallet_overview',
      Effect.map(asToolError(walletOverview(ctx)), ({ value }): Outcome => ({
        state: 'ok',
        amount: null,
        fee: null,
        detail: `The wallet holds ${value.balances.usdc} USDC. The sample agent may spend ${value.grant_remaining} USDC of it on its own; anything bigger needs your nod.`,
        links: [{ label: 'wallet', url: walletUrl }],
      })),
    )

    // 2. paid_resource_fetch: the market brief over x402
    yield* step(
      '2',
      `It buys a market brief for ${SAMPLE_AMOUNTS.brief} USDC over x402`,
      'paid_resource_fetch',
      Effect.map(
        asToolError(
          paidResourceFetch(ctx, {
            url: MARKET_BRIEF_URL,
            max_amount: SAMPLE_AMOUNTS.brief,
            reason: 'market brief for the sample run',
            idempotency_key: keyOf(input.id, 'brief'),
          }),
        ),
        ({ value }): Outcome => {
          const receipt = value.receipt
          const links = [
            ...(receipt === null ? [] : [{ label: 'settlement', url: receipt.explorer_url }]),
            ...(receipt?.pull_tx_hash
              ? [{ label: 'pull into the pocket', url: receipt.pull_explorer_url ?? tx(receipt.pull_tx_hash) }]
              : value.pull === null
                ? []
                : [{ label: 'pull into the pocket', url: value.pull.explorer_url }]),
          ]
          if (value.status === 'paid' && receipt !== null)
            return {
              state: 'paid',
              amount: `${value.price ?? SAMPLE_AMOUNTS.brief} USDC`,
              fee: 'the facilitator paid the settlement fee; Nod paid the pull',
              detail: `No nod needed: it fits the allowance. The agent's key pulled 1.00 USDC into its pocket under the rule, and a public facilitator settled the 0.10 from there. ${value.grant_remaining} USDC left.${value.body === null ? '' : ` The seller answered: ${value.body.slice(0, 140)}${value.body.length > 140 ? '…' : ''}`}`,
              links,
            }
          return {
            state: value.status === 'requires_approval' ? 'needs_nod' : 'failed',
            amount: value.price === null ? null : `${value.price} USDC`,
            fee: null,
            detail: value.message,
            links,
          }
        },
      ),
    )

    // 3. Alice, inside the allowance
    yield* step(
      '3',
      `It pays Alice ${SAMPLE_AMOUNTS.alice} USDC on its own`,
      'payment_prepare → payment_execute',
      Effect.gen(function* () {
        const prepared = (yield* asToolError(
          paymentPrepare(ctx, {
            recipient: 'Alice',
            amount: SAMPLE_AMOUNTS.alice,
            reason: 'sample: pay Alice',
            idempotency_key: keyOf(input.id, 'alice'),
          }),
        )).value
        const paid =
          prepared.status === 'prepared'
            ? (yield* asToolError(paymentExecute(ctx, prepared.payment_id))).value
            : prepared
        return paid.status === 'confirmed' && paid.receipt !== null
          ? {
              state: 'paid',
              amount: `${paid.amount} USDC`,
              fee: feeOf(paid.receipt),
              detail: `Signed by the agent's own key and checked by the OpenZeppelin spending-limit policy on the account. ${paid.grant_remaining} USDC left.`,
              links: [{ label: 'payment', url: paid.receipt.explorer_url }],
            }
          : {
              state: 'failed',
              amount: `${paid.amount} USDC`,
              fee: null,
              detail: paid.failure ?? paid.next_step,
              links: [],
            }
      }),
    )

    // 4. dinner: above the allowance → needs your nod
    const dinner = {
      recipient: 'Bob',
      amount: SAMPLE_AMOUNTS.dinner,
      reason: 'dinner',
      idempotency_key: keyOf(input.id, 'dinner'),
    }
    const asked = yield* asToolError(paymentPrepare(ctx, dinner)).pipe(
      Effect.map(result => result.value),
      Effect.result,
    )
    yield* step(
      '4',
      `It asks for ${SAMPLE_AMOUNTS.dinner} USDC to Bob for dinner`,
      'payment_prepare',
      asked._tag === 'Failure'
        ? Effect.fail(asked.failure)
        : Effect.succeed<Outcome>({
            state: asked.success.status === 'awaiting_approval' ? 'needs_nod' : 'failed',
            amount: `${asked.success.amount} USDC`,
            fee: null,
            detail:
              asked.success.status === 'awaiting_approval'
                ? `More than the allowance, so it needs your nod. The agent gets an approval link, not an error, and nothing moves yet. Still ${asked.success.grant_remaining} USDC left.`
                : asked.success.next_step,
            links:
              asked.success.approval_url === null ? [] : [{ label: 'approval page', url: asked.success.approval_url }],
          }),
    )

    // 5. the demo owner nods; the agent polls payment_status
    const settled =
      asked._tag === 'Success' && asked.success.status === 'awaiting_approval'
        ? yield* step(
            '5',
            'The demo owner nods with its passkey; the agent polls and gets the receipt',
            'approval page → payment_status',
            Effect.gen(function* () {
              yield* nod(owner, asked.success.payment_id)
              const status = (yield* asToolError(paymentStatus(ctx, asked.success.payment_id))).value
              return status.status === 'confirmed' && status.receipt !== null
                ? {
                    state: 'nodded',
                    amount: `${status.amount} USDC`,
                    fee: feeOf(status.receipt),
                    detail: `The passkey signed exactly this payment: ${status.amount} USDC to Bob (${status.recipient.address}). It did not touch the allowance: ${status.grant_remaining} USDC left.`,
                    links: [{ label: 'payment', url: status.receipt.explorer_url }],
                  }
                : {
                    state: 'failed',
                    amount: `${status.amount} USDC`,
                    fee: null,
                    detail: status.failure ?? status.next_step,
                    links: [],
                  }
            }),
          )
        : undefined

    // 6. the same request again: same receipt
    yield* step(
      '6',
      'It repeats the dinner request with the same idempotency key',
      'payment_prepare',
      Effect.gen(function* () {
        const again = (yield* asToolError(paymentPrepare(ctx, dinner))).value
        const same =
          asked._tag === 'Success' &&
          again.payment_id === asked.success.payment_id &&
          again.status === 'confirmed' &&
          settled?.state === 'nodded'
        return {
          state: same ? 'same_receipt' : 'failed',
          amount: `${again.amount} USDC`,
          fee: null,
          detail: same
            ? `Same payment ${again.payment_id}, same receipt: nothing was paid twice.`
            : `Payment ${again.payment_id} is ${again.status}.`,
          links: again.receipt === null ? [] : [{ label: 'the one payment', url: again.receipt.explorer_url }],
        }
      }),
    )

    // 7. 4 USDC with 2.90 left: needs your nod, left unapproved
    yield* step(
      '7',
      `It asks for ${SAMPLE_AMOUNTS.tooMuch} USDC more for Alice`,
      'payment_prepare',
      Effect.map(
        asToolError(
          paymentPrepare(ctx, {
            recipient: 'Alice',
            amount: SAMPLE_AMOUNTS.tooMuch,
            reason: 'sample: more than what is left',
            idempotency_key: keyOf(input.id, 'too-much'),
          }),
        ),
        ({ value }): Outcome => ({
          state: value.status === 'awaiting_approval' ? 'left_pending' : 'failed',
          amount: `${value.amount} USDC`,
          fee: null,
          detail:
            value.status === 'awaiting_approval'
              ? `${value.amount} is more than the ${value.grant_remaining} left, so it comes back to the owner instead of failing on Stellar. The sample leaves this one unapproved; it expires in 30 minutes.`
              : value.next_step,
          links: value.approval_url === null ? [] : [{ label: 'approval page', url: value.approval_url }],
        }),
      ),
    )

    // 8. Carol, who has never held USDC: claim link (CAP-73)
    const carol = settings.demoContacts.find(contact => contact.name === 'Carol')
    const carolReady =
      carol === undefined
        ? 'missing'
        : yield* chain.readiness(carol.address).pipe(Effect.catchTag('ChainError', () => Effect.succeed('unknown')))
    if (carolReady !== 'trustline_required')
      yield* say({
        step: '8',
        title: `Send Carol ${SAMPLE_AMOUNTS.carol} USDC through a claim link`,
        tool: 'payment_prepare → claim link',
        state: 'skipped',
        amount: `${fromStroops(toStroops(SAMPLE_AMOUNTS.carol))} USDC`,
        fee: null,
        detail:
          carolReady === 'usdc_ready'
            ? 'Carol already onboarded; run `treasury.ts --new-carol` to reset. (Her trustline already exists, so there is no claim to show.)'
            : `Carol cannot be checked right now (${carolReady}); skipped.`,
        links: carol === undefined ? [] : [{ label: 'Carol', url: `${network.explorerBase}/account/${carol.address}` }],
      })
    else {
      const claim = yield* asToolError(
        paymentPrepare(ctx, {
          recipient: 'Carol',
          amount: SAMPLE_AMOUNTS.carol,
          reason: 'claim-link demo',
          idempotency_key: keyOf(input.id, 'carol'),
        }),
      ).pipe(
        Effect.map(result => result.value),
        Effect.result,
      )
      yield* step(
        '8',
        `It asks to send Carol ${SAMPLE_AMOUNTS.carol} USDC; she has never held USDC`,
        'payment_prepare',
        claim._tag === 'Failure'
          ? Effect.fail(claim.failure)
          : Effect.succeed<Outcome>({
              state: claim.success.status === 'awaiting_approval' ? 'needs_nod' : 'failed',
              amount: `${claim.success.amount} USDC`,
              fee: null,
              detail: `Carol has no USDC trustline, so the payment needs your nod and then Carol's acceptance on a claim link.`,
              links: [
                ...(claim.success.approval_url === null
                  ? []
                  : [{ label: 'approval page', url: claim.success.approval_url }]),
                ...(claim.success.claim_url === null ? [] : [{ label: 'claim link', url: claim.success.claim_url }]),
              ],
            }),
      )
      if (claim._tag === 'Success' && claim.success.status === 'awaiting_approval')
        yield* step(
          '8',
          'The demo owner nods; Carol accepts; trustline and payment land in one transaction',
          'approval page → claim link (?demo=1) → payment_status',
          Effect.gen(function* () {
            yield* nod(owner, claim.success.payment_id)
            yield* acceptClaimAsDemoRecipient(owner, claim.success.payment_id)
            const status = (yield* asToolError(paymentStatus(ctx, claim.success.payment_id))).value
            return status.status === 'confirmed' && status.receipt !== null
              ? {
                  state: 'paid',
                  amount: `${status.amount} USDC`,
                  fee: feeOf(status.receipt),
                  detail:
                    "One Stellar transaction: the USDC contract's trust(Carol) and the transfer (CAP-73). On testnet Nod holds Carol's demo key and signs her acceptance.",
                  links: [{ label: 'trust + transfer', url: status.receipt.explorer_url }],
                }
              : {
                  state: 'failed',
                  amount: `${status.amount} USDC`,
                  fee: null,
                  detail: status.failure ?? status.next_step,
                  links: [],
                }
          }),
        )
    }

    // 9. revoke: service stops, pocket swept, rule removed; the next payment is refused
    yield* step(
      '9',
      'The owner revokes the sample agent',
      'connection_grant_revoke → revoke page',
      Effect.gen(function* () {
        const revoked = (yield* asToolError(connectionGrantRevoke(ctx, keyOf(input.id, 'revoke')))).value
        const removal = yield* removeRule(owner, ctx.props.connection_id)
        const sweep = revoked.sweep_tx ?? (yield* grantOfConnection(ctx.props.connection_id))?.sweep_tx ?? null
        return {
          state: removal.rule_status === 'removed' ? 'revoked' : 'failed',
          amount: null,
          fee: 'Nod paid the network fees',
          detail: `Nod stopped signing for the agent at once${sweep === null ? '' : ", swept the pocket's leftover back into the wallet"}, and the demo owner's passkey removed the allowance from the Stellar account.`,
          links: [
            ...(removal.tx === null ? [] : [{ label: 'allowance removed', url: tx(removal.tx) }]),
            ...(sweep === null ? [] : [{ label: 'pocket swept', url: tx(sweep) }]),
          ],
        }
      }),
    )
    yield* step(
      '9',
      'Its next payment is refused',
      'payment_prepare',
      Effect.gen(function* () {
        const after = yield* asToolError(
          paymentPrepare(ctx, {
            recipient: 'Alice',
            amount: '0.01',
            reason: 'after revoke',
            idempotency_key: keyOf(input.id, 'after-revoke'),
          }),
        ).pipe(Effect.result)
        return after._tag === 'Failure'
          ? { state: 'refused', amount: '0.01 USDC', fee: null, detail: after.failure.message, links: [] }
          : {
              state: 'failed',
              amount: '0.01 USDC',
              fee: null,
              detail: `Not refused: ${after.success.value.status}.`,
              links: [],
            }
      }),
    )

    // The end: where to look
    const final = yield* asToolError(walletOverview(ctx)).pipe(Effect.result)
    yield* say({
      step: 'end',
      title: 'Done. Every transaction is on Stellar testnet',
      tool: null,
      state: 'ok',
      amount: null,
      fee: null,
      detail: `${final._tag === 'Success' ? `The demo wallet now holds ${final.success.value.balances.usdc} USDC and ${final.success.value.balances.xlm === '0.00' ? 'no' : final.success.value.balances.xlm} XLM: Nod paid every network fee. ` : ''}Open the wallet on stellar.expert to see each payment, the allowance rule and its removal.`,
      links: [{ label: 'demo wallet on stellar.expert', url: walletUrl }],
    })
    return yield* snapshot('done', null)
  })

/** Run on the service's runtime; resolves with the finished run (failed runs included), never rejects on a step. */
export const executeSample = (runtime: AppRuntime, input: SampleInput, report: (run: SampleRun) => Promise<void>) =>
  runtime.runPromise(sampleProgram(runtime, input, report))
