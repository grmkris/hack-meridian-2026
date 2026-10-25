import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, type GrantView, Overview, type PendingApproval, type Resources } from '../backend'
import { dateTime, explorerAccountUrl, isMainnet, networkLabel, percentUsed, shortAddress, usdc, xlm } from '../format'
import { Problem, recoverProblem } from '../problem'
import { connectionsRouter, receiptsRouter } from '../route'
import { qrModules, qrPath } from '../view/qr'
import { receiptRow } from '../view/receipt'
import { BUTTON_PRIMARY, BUTTON_SECONDARY, LINK, badge, emptyRow, errorRow, loadingRow, meter, panel } from '../view/ui'

// MODEL

export const OverviewData = AsyncData.Schema(Overview, Schema.String)

export const AddressCopy = defineTaggedUnion({
  Idle: {},
  Copied: {},
  Failed: {},
})
export type AddressCopy = typeof AddressCopy.Type

export const Model = Schema.Struct({ overview: OverviewData.schema, addressCopy: AddressCopy })
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
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ EndedSession: {} })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Update.Return<Model, Message, Resources> => ({
  model: { overview: OverviewData.Idle(), addressCopy: AddressCopy.Idle() },
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

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () => startLoad(model),
    ClickedRefresh: () => startLoad(model),
    SucceededLoadOverview: ({ overview }) => ({
      model: modifyFields(model, { overview: () => OverviewData.Success({ data: overview }) }),
    }),
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
  })

export const informEntered = (model: Model) => update(model, Message.EnteredPage())

// VIEW

const walletPanel = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  panel(
    'Wallet balance',
    [
      h.p(
        [h.Class('text-4xl font-semibold tracking-tight tabular-nums text-ink sm:text-5xl')],
        [usdc(overview.balances.usdc)],
      ),
      h.p([h.Class('mt-2 text-sm text-muted')], [`${xlm(overview.balances.xlm)} · Nod pays the network fee`]),
      h.p(
        [h.Class('mt-4 flex flex-wrap items-center gap-x-2 text-sm text-muted')],
        [
          `${overview.wallet.name} smart account on ${networkLabel(overview.network ?? overview.wallet.network)}`,
          h.a(
            [
              h.Href(
                explorerAccountUrl(
                  overview.network ?? overview.wallet.network,
                  overview.wallet.contract_id,
                  overview.explorer_base,
                ),
              ),
              h.Target('_blank'),
              h.Rel('noreferrer'),
              h.Class(`${LINK} font-mono`),
            ],
            [shortAddress(overview.wallet.contract_id)],
          ),
        ],
      ),
    ],
    h,
  )

const allowanceRow = (grant: GrantView, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    grant.connection_id,
    [h.Class('flex flex-col gap-2 py-4 first:pt-0 last:pb-0')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-4')],
        [
          h.span([h.Class('font-semibold text-ink')], [grant.client_name]),
          h.span([h.Class('text-sm tabular-nums text-muted')], [`of ${usdc(grant.total)}`]),
        ],
      ),
      h.p([h.Class('text-2xl font-semibold tabular-nums text-accent')], [`${usdc(grant.remaining)} left`]),
      meter(percentUsed(grant.total, grant.remaining), `${grant.client_name} allowance used`, h),
      h.p(
        [h.Class('text-sm text-muted')],
        [
          Option.match(Option.fromNullishOr(grant.valid_until), {
            onNone: () => 'Waiting for your nod to set the allowance',
            onSome: until => `Until ${dateTime(until)}`,
          }),
        ],
      ),
    ],
  )

const allowancePanel = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  panel(
    'What your AI may spend',
    [
      Array.match(overview.grants, {
        onEmpty: () =>
          emptyRow('No AI app yet. Add Nod to Claude as a connector, and set its allowance with your passkey.', h),
        onNonEmpty: grants =>
          h.ul(
            [h.Class('divide-y divide-line')],
            Array.map(grants, grant => allowanceRow(grant, h)),
          ),
      }),
      h.a([h.Href(connectionsRouter()), h.Class(`${LINK} mt-4 inline-block text-sm`)], ['Manage connections']),
    ],
    h,
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
            [h.Class('text-lg font-semibold tabular-nums text-ink')],
            [`${usdc(approval.amount)} to ${approval.recipient_name ?? shortAddress(approval.recipient_address)}`],
          ),
          h.p(
            [h.Class('text-sm text-muted')],
            [`${approval.requester} asked · expires ${dateTime(approval.expires_at)}`],
          ),
          ...Option.match(Option.fromNullishOr(approval.reason), {
            onNone: () => [],
            onSome: reason => [
              h.p([h.Class('text-sm italic text-muted')], [`${approval.requester} says: “${reason}”`]),
            ],
          }),
        ],
      ),
      h.a([h.Href(approval.approve_url), h.Class(`${BUTTON_PRIMARY} shrink-0`)], ['Review']),
    ],
  )

const approvalsPanel = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  panel(
    'Needs your nod',
    [
      Array.match(overview.pending, {
        onEmpty: () => emptyRow('Nothing is waiting. A payment over an allowance shows up here for your nod.', h),
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

const addMoneyPanel = (overview: Overview, addressCopy: AddressCopy, h: HtmlBuilder<Message>): Html => {
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
        ],
        h,
      ),
    ],
  )
}

const loadedView = (overview: Overview, addressCopy: AddressCopy, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      h.div([h.Class('grid gap-5 lg:grid-cols-2')], [walletPanel(overview, h), allowancePanel(overview, h)]),
      addMoneyPanel(overview, addressCopy, h),
      approvalsPanel(overview, h),
      activityPanel(overview, h),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      h.div(
        [h.Class('flex items-center justify-between gap-4')],
        [
          h.h1([h.Class('text-2xl font-semibold tracking-tight text-ink sm:text-3xl')], ['Home']),
          h.button([h.Type('button'), h.OnClick(Message.ClickedRefresh()), h.Class(BUTTON_SECONDARY)], ['Refresh']),
        ],
      ),
      AsyncData.matchData(model.overview, {
        onEmpty: () => loadingRow(h),
        onFailure: error => errorRow(error, h),
        onData: overview => loadedView(overview, model.addressCopy, h),
      }),
    ],
  ),
)
