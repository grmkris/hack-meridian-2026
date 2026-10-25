import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, DepositAddressView, type GrantView, Overview, type PendingApproval, type Resources } from '../backend'
import { dateTime, explorerAccountUrl, isMainnet, networkLabel, percentUsed, shortAddress, usdc } from '../format'
import { Problem, recoverProblem } from '../problem'
import { connectionsRouter, receiptsRouter } from '../route'
import { qrModules, qrPath } from '../view/qr'
import { receiptRow } from '../view/receipt'
import {
  BUTTON_NOD,
  BUTTON_SECONDARY,
  FIGURE,
  LINK,
  badge,
  emptyRow,
  errorRow,
  loadingRow,
  meter,
  panel,
} from '../view/ui'

// MODEL

export const OverviewData = AsyncData.Schema(Overview, Schema.String)
/** The wallet's deposit address (a `G…` exchanges can pay), loaded once the wallet has one or waits for its first USDC. */
export const DepositData = AsyncData.Schema(DepositAddressView, Schema.String)
type DepositData = typeof DepositData.schema.Type

export const AddressCopy = defineTaggedUnion({
  Idle: {},
  Copied: {},
  Failed: {},
})
export type AddressCopy = typeof AddressCopy.Type

export const Model = Schema.Struct({
  overview: OverviewData.schema,
  addressCopy: AddressCopy,
  deposit: DepositData.schema,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  EnteredPage: {},
  ClickedRefresh: {},
  SucceededLoadOverview: { overview: Overview },
  FailedLoadOverview: { problem: Problem },
  ClickedCopyAddress: { address: Schema.String },
  CompletedCopyAddress: {},
  FailedCopyAddress: {},
  ClickedGetDepositAddress: {},
  SucceededLoadDeposit: { deposit: DepositAddressView },
  FailedLoadDeposit: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ EndedSession: {} })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Update.Return<Model, Message, Resources> => ({
  model: { overview: OverviewData.Idle(), addressCopy: AddressCopy.Idle(), deposit: DepositData.Idle() },
})

// COMMAND

export const LoadOverview = Command.define('LoadOverview', {
  messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const overview = yield* backend.overview
    return Message.SucceededLoadOverview({ overview })
  }).pipe(recoverProblem(problem => Message.FailedLoadOverview({ problem }))),
})

export const LoadDeposit = Command.define('LoadDeposit', {
  messages: [Message.SucceededLoadDeposit, Message.FailedLoadDeposit],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const deposit = yield* backend.depositAddress
    return Message.SucceededLoadDeposit({ deposit })
  }).pipe(recoverProblem(problem => Message.FailedLoadDeposit({ problem }))),
})

export const CopyAddress = Command.define('CopyAddress', {
  args: { address: Schema.String },
  messages: [Message.CompletedCopyAddress, Message.FailedCopyAddress],
  execute: ({ address }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(address)).pipe(
      Effect.as(Message.CompletedCopyAddress()),
      Effect.orElseSucceed(() => Message.FailedCopyAddress()),
    ),
})

// UPDATE

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const startLoad = (model: Model): UpdateReturn =>
  Option.match(AsyncData.revalidateOrLoad(model.overview), {
    onNone: () => ({ model }),
    onSome: nextOverview => ({
      model: modifyFields(model, { overview: () => nextOverview }),
      commands: [LoadOverview()],
    }),
  })

const startDeposit = (model: Model): UpdateReturn =>
  Option.match(AsyncData.revalidateOrLoad(model.deposit), {
    onNone: () => ({ model }),
    onSome: nextDeposit => ({
      model: modifyFields(model, { deposit: () => nextDeposit }),
      commands: [LoadDeposit()],
    }),
  })

/** A deposit-first wallet waits for its first USDC there; a wallet that has an address shows it again. */
const wantsDeposit = (overview: Overview): boolean =>
  overview.wallet.account_status === 'awaiting_deposit' ||
  (overview.wallet.deposit_address !== undefined && overview.wallet.deposit_address !== null)

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () => startLoad(model),
    ClickedRefresh: () => startLoad(model),
    SucceededLoadOverview: ({ overview }) => {
      const loaded = modifyFields(model, { overview: () => OverviewData.Success({ data: overview }) })
      return wantsDeposit(overview) ? startDeposit(loaded) : { model: loaded }
    },
    FailedLoadOverview: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({
          model: modifyFields(model, { overview: () => OverviewData.Idle() }),
          outMessage: OutMessage.EndedSession(),
        }),
        Failed: ({ error }) => ({ model: modifyFields(model, { overview: () => OverviewData.Failure({ error }) }) }),
      }),
    ClickedCopyAddress: ({ address }) => ({ model, commands: [CopyAddress({ address })] }),
    CompletedCopyAddress: () => ({ model: modifyFields(model, { addressCopy: () => AddressCopy.Copied() }) }),
    FailedCopyAddress: () => ({ model: modifyFields(model, { addressCopy: () => AddressCopy.Failed() }) }),
    ClickedGetDepositAddress: () => (AsyncData.isLoading(model.deposit) ? { model } : startDeposit(model)),
    SucceededLoadDeposit: ({ deposit }) => ({
      model: modifyFields(model, { deposit: () => DepositData.Success({ data: deposit }) }),
    }),
    FailedLoadDeposit: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({ model, outMessage: OutMessage.EndedSession() }),
        Failed: ({ error }) => ({ model: modifyFields(model, { deposit: () => DepositData.Failure({ error }) }) }),
      }),
  })

export const informEntered = (model: Model) => update(model, Message.EnteredPage())

// VIEW

const twoNumberColumn = (title: string, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-col gap-2 p-5 sm:p-7')],
    [h.h2([h.Class('text-sm font-semibold text-muted')], [title]), ...children],
  )

const walletColumn = (overview: Overview, h: HtmlBuilder<Message>): Html => {
  const network = overview.network ?? overview.wallet.network
  return twoNumberColumn(
    'Wallet balance',
    [
      h.p(
        [
          h.DataAttribute('testid', 'wallet-balance'),
          h.Class(`${FIGURE} text-[2.75rem] leading-none text-ink sm:text-6xl`),
        ],
        [usdc(overview.balances.usdc)],
      ),
      h.p(
        [h.Class('mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted')],
        [
          h.span([], [`${overview.wallet.name} on Stellar ${networkLabel(network)}`]),
          h.a(
            [
              h.Href(explorerAccountUrl(network, overview.wallet.contract_id, overview.explorer_base)),
              h.Target('_blank'),
              h.Rel('noreferrer'),
              h.Title(overview.wallet.contract_id),
              h.Class(`${LINK} font-mono text-[0.8125rem]`),
            ],
            [shortAddress(overview.wallet.contract_id)],
          ),
        ],
      ),
      h.p([h.Class('text-sm text-muted')], ['Nod pays the network fee.']),
    ],
    h,
  )
}

const allowanceRow = (grant: GrantView, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    grant.connection_id,
    [h.Class('flex flex-col gap-2 py-4 first:pt-0 last:pb-0')],
    [
      h.p([h.Class('text-sm text-ink')], [h.span([h.Class('font-semibold')], [grant.client_name]), ' may still spend']),
      h.p(
        [h.Class('flex flex-wrap items-baseline gap-x-2')],
        [
          h.span([h.Class(`${FIGURE} text-[2.75rem] leading-none text-accent sm:text-6xl`)], [usdc(grant.remaining)]),
          h.span([h.Class('text-sm tabular-nums text-muted')], [`of ${usdc(grant.total)}`]),
        ],
      ),
      meter(percentUsed(grant.total, grant.remaining), `${grant.client_name} allowance used`, h),
      h.p(
        [h.Class('text-sm text-muted')],
        [
          Option.match(Option.fromNullishOr(grant.valid_until), {
            onNone: () => 'Waiting for your passkey to set the allowance',
            onSome: until => `On its own until ${dateTime(until)}`,
          }),
        ],
      ),
    ],
  )

const allowanceColumn = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  twoNumberColumn(
    Array.match(overview.grants, {
      onEmpty: () => 'What your AI may spend',
      onNonEmpty: grants => (grants.length === 1 ? 'What your AI may spend' : 'What each AI app may spend'),
    }),
    [
      Array.match(overview.grants, {
        onEmpty: () =>
          h.p(
            [h.Class('text-sm text-muted')],
            ['No AI app yet. Add Nod to Claude as a connector and give it an allowance with your passkey.'],
          ),
        onNonEmpty: grants =>
          h.ul(
            [h.Class('flex flex-col divide-y divide-line')],
            Array.map(grants, grant => allowanceRow(grant, h)),
          ),
      }),
      h.p([h.Class('mt-1 text-sm text-ink')], ['Anything bigger needs your passkey, every time.']),
      h.a([h.Href(connectionsRouter()), h.Class(`${LINK} self-start text-sm`)], ['Manage connections']),
    ],
    h,
  )

/** The two numbers that never blur: what the wallet holds, and what each AI app may still spend on its own. */
const twoNumbers = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.AriaLabel('Your wallet and your allowances'),
      h.Class(
        'grid overflow-clip rounded-[1.75rem] bg-paper shadow-[0_0_0_1px_var(--color-line),0_1px_2px_rgb(18_22_31/0.05)] lg:grid-cols-2',
      ),
    ],
    [
      walletColumn(overview, h),
      h.div([h.Class('border-t border-line lg:border-t-0 lg:border-l')], [allowanceColumn(overview, h)]),
    ],
  )

const approvalRow = (approval: PendingApproval, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    approval.intent_id,
    [h.Class('flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between')],
    [
      h.div(
        [h.Class('flex min-w-0 flex-col gap-1')],
        [
          h.p(
            [h.Class('text-ink')],
            [
              h.span([h.Class(`${FIGURE} text-2xl`)], [usdc(approval.amount)]),
              ` to ${approval.recipient_name ?? shortAddress(approval.recipient_address)}`,
            ],
          ),
          h.p(
            [h.Class('text-sm text-muted')],
            [`Asked by ${approval.requester} · open until ${dateTime(approval.expires_at)}`],
          ),
          ...Option.match(Option.fromNullishOr(approval.reason), {
            onNone: () => [],
            onSome: reason => [
              h.p(
                [h.Class('border-l-2 border-line pl-3 text-sm text-muted [overflow-wrap:anywhere]')],
                [h.span([h.Class('italic text-ink')], [`“${reason}”`]), ` ${approval.requester}’s words`],
              ),
            ],
          }),
        ],
      ),
      h.a([h.Href(approval.approve_url), h.Class(`${BUTTON_NOD} shrink-0`)], ['Review and approve']),
    ],
  )

const approvalsPanel = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  panel(
    'Needs your nod',
    [
      Array.match(overview.pending, {
        onEmpty: () => emptyRow('Nothing is waiting. A payment past an allowance shows up here for your passkey.', h),
        onNonEmpty: pending =>
          h.ul(
            [h.Class('divide-y divide-line')],
            Array.map(pending, approval => approvalRow(approval, h)),
          ),
      }),
    ],
    h,
  )

const activityPanel = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  panel(
    'Recent activity',
    [
      Array.match(overview.receipts, {
        onEmpty: () => emptyRow('No payments yet.', h),
        onNonEmpty: receipts =>
          h.ul(
            [h.Class('divide-y divide-line')],
            Array.map(receipts, receipt => receiptRow(receipt, h)),
          ),
      }),
      h.a([h.Href(receiptsRouter()), h.Class(`${LINK} mt-2 inline-block text-sm`)], ['All receipts']),
    ],
    h,
  )

const addressQr = (address: string, h: HtmlBuilder<Message>): Html => {
  const maybeModules = Option.fromNullishOr(qrModules(address))
  return Option.match(maybeModules, {
    onNone: () => h.empty,
    onSome: modules =>
      h.svg(
        [
          h.ViewBox(`0 0 ${modules.length + 8} ${modules.length + 8}`),
          h.Role('img'),
          h.AriaLabel('QR code of your wallet address'),
          h.DataAttribute('testid', 'address-qr'),
          h.Class('size-40 shrink-0 rounded-2xl bg-white ring-1 ring-line sm:size-44'),
        ],
        [h.path([h.D(qrPath(modules)), h.Fill('#14171a'), h.ShapeRendering('crispEdges')])],
      ),
  })
}

/** Testnet amounts in stroops as "1.50 USDC"; a missing reading as "unknown". */
const depositFacts = (deposit: DepositAddressView, h: HtmlBuilder<Message>): Html =>
  h.dl(
    [h.Class('grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted')],
    [
      h.dt([], ['Waiting to arrive']),
      h.dd(
        [h.DataAttribute('testid', 'deposit-pending'), h.Class('tabular-nums text-ink')],
        [deposit.pending === null ? 'unknown' : usdc(deposit.pending)],
      ),
      h.dt([], ['Received so far']),
      h.dd([h.DataAttribute('testid', 'deposit-swept'), h.Class('tabular-nums text-ink')], [usdc(deposit.swept_total)]),
      h.dt([], ['Works until']),
      h.dd([h.DataAttribute('testid', 'deposit-expires'), h.Class('text-ink')], [dateTime(deposit.expires_at)]),
    ],
  )

/**
 * The deposit address: a `G…` any exchange or wallet can pay USDC to, no memo; Nod's deposit router moves it into this
 * wallet and nowhere else. Loaded for a wallet that waits for its first USDC or already has one; otherwise on request.
 */
const depositBlock = (overview: Overview, deposit: DepositData, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.DataAttribute('testid', 'deposit'), h.Class('flex flex-col gap-3 border-t border-line pt-5')],
    [
      h.p(
        [h.Class('text-sm text-ink')],
        [
          overview.wallet.account_status === 'awaiting_deposit'
            ? 'Send USDC from any exchange or Stellar wallet to this deposit address. No memo. Your wallet opens when the first USDC arrives.'
            : 'From an exchange or any Stellar wallet: send USDC to your deposit address. No memo. It lands in this wallet.',
        ],
      ),
      AsyncData.match(deposit, {
        onIdle: () =>
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedGetDepositAddress()),
              h.DataAttribute('testid', 'get-deposit-address'),
              h.Class(`${BUTTON_SECONDARY} self-start`),
            ],
            ['Get a deposit address'],
          ),
        onLoading: () => h.p([h.Class('text-sm text-muted')], ['Preparing your deposit address (about 15 s)…']),
        onRefreshing: data => depositLoaded(data, h),
        onStale: ({ data }) => depositLoaded(data, h),
        onSuccess: data => depositLoaded(data, h),
        onFailure: error =>
          h.p(
            [h.DataAttribute('testid', 'deposit-error'), h.Class('text-sm text-muted')],
            [
              error.startsWith('deposit_unavailable')
                ? 'Deposit addresses are not available on this network yet.'
                : error,
            ],
          ),
      }),
    ],
  )

const depositLoaded = (deposit: DepositAddressView, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-3')],
    [
      h.p(
        [
          h.DataAttribute('testid', 'deposit-address'),
          h.Class('break-all rounded-xl bg-mist px-3 py-2 font-mono text-sm text-ink'),
        ],
        [deposit.address],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedCopyAddress({ address: deposit.address })),
          h.DataAttribute('testid', 'copy-deposit-address'),
          h.Class(`${BUTTON_SECONDARY} self-start`),
        ],
        ['Copy deposit address'],
      ),
      depositFacts(deposit, h),
    ],
  )

const addMoneyPanel = (
  overview: Overview,
  addressCopy: AddressCopy,
  deposit: DepositData,
  h: HtmlBuilder<Message>,
): Html => {
  const network = overview.network ?? overview.wallet.network
  const address = overview.wallet.contract_id
  return h.div(
    [h.DataAttribute('testid', 'add-money')],
    [
      panel(
        'Add money',
        [
          h.div(
            [h.Class('flex flex-col gap-5 sm:flex-row sm:items-start')],
            [
              addressQr(address, h),
              h.div(
                [h.Class('flex min-w-0 flex-col gap-3')],
                [
                  h.p(
                    [h.Class('flex flex-wrap items-center gap-2 text-sm text-ink')],
                    [
                      `Send USDC on Stellar to your wallet address`,
                      badge(networkLabel(network), isMainnet(network) ? 'good' : 'warn', h),
                    ],
                  ),
                  h.p(
                    [
                      h.DataAttribute('testid', 'wallet-address'),
                      h.Class('break-all rounded-xl bg-mist px-3 py-2 font-mono text-sm text-ink'),
                    ],
                    [address],
                  ),
                  h.div(
                    [h.Class('flex flex-wrap items-center gap-3')],
                    [
                      h.button(
                        [
                          h.Type('button'),
                          h.OnClick(Message.ClickedCopyAddress({ address })),
                          h.DataAttribute('testid', 'copy-address'),
                          h.Class(BUTTON_SECONDARY),
                        ],
                        [
                          AddressCopy.match(addressCopy, {
                            Idle: () => 'Copy address',
                            Copied: () => 'Copied',
                            Failed: () => 'Copy address',
                          }),
                        ],
                      ),
                      h.span(
                        [h.AriaLive('polite'), h.Class('text-sm text-muted')],
                        [
                          AddressCopy.match(addressCopy, {
                            Idle: () => '',
                            Copied: () => 'Paste it in the wallet you send from.',
                            Failed: () => 'Copying is blocked here; select the address and copy it.',
                          }),
                        ],
                      ),
                    ],
                  ),
                  h.p(
                    [h.Class('text-sm text-muted')],
                    [
                      'Works from wallets that can send to contract addresses (Freighter). Deposit addresses for exchanges are next.',
                    ],
                  ),
                ],
              ),
            ],
          ),
          depositBlock(overview, deposit, h),
        ],
        h,
      ),
    ],
  )
}

const loadedView = (
  overview: Overview,
  addressCopy: AddressCopy,
  deposit: DepositData,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      twoNumbers(overview, h),
      ...Array.match(overview.pending, { onEmpty: () => [], onNonEmpty: () => [approvalsPanel(overview, h)] }),
      addMoneyPanel(overview, addressCopy, deposit, h),
      activityPanel(overview, h),
      ...Array.match(overview.pending, { onEmpty: () => [approvalsPanel(overview, h)], onNonEmpty: () => [] }),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      h.div(
        [h.Class('flex items-center justify-between gap-4')],
        [
          h.h1([h.Class('font-display text-3xl font-bold tracking-[-0.015em] text-ink sm:text-4xl')], ['Home']),
          h.button([h.Type('button'), h.OnClick(Message.ClickedRefresh()), h.Class(BUTTON_SECONDARY)], ['Refresh']),
        ],
      ),
      AsyncData.matchData(model.overview, {
        onEmpty: () => loadingRow(h),
        onFailure: error => errorRow(error, h),
        onData: overview => loadedView(overview, model.addressCopy, model.deposit, h),
      }),
    ],
  ),
)
