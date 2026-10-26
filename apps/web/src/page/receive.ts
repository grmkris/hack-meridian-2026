import { Array, Effect, Match, Option, Schema } from 'effect'
import { AsyncData, Command, Submodel, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, DepositAddressView, type Overview, type Resources, TopupChain, TopupQuoteView } from '../backend'
import { dateTime, explorerAccountUrl, isMainnet, networkLabel, shortAddress, usdc } from '../format'
import { Problem, recoverProblem } from '../problem'
import { homeRouter } from '../route'
import { qrModules, qrPath } from '../view/qr'
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIGURE, INPUT, LINK, badge, errorRow, loadingRow } from '../view/ui'

// MODEL
export const DepositData = AsyncData.Schema(DepositAddressView, Schema.String)
export const AddressCopy = defineTaggedUnion({
  Idle: {},
  Copying: { address: Schema.String },
  Copied: {},
  Failed: {},
})
export type AddressCopy = typeof AddressCopy.Type

export const TopupAssetsData = AsyncData.Schema(Schema.Array(TopupChain), Schema.String)

/** What the person picked and typed for a top-up: chain, asset id, amount in that asset, refund address on that chain. */
export const TopupForm = Schema.Struct({
  chain: Schema.String,
  assetId: Schema.String,
  amount: Schema.String,
  refundTo: Schema.String,
})
export type TopupForm = typeof TopupForm.Type

export const Topup = defineTaggedUnion({
  Editing: {},
  Quoting: {},
  Quoted: { quote: TopupQuoteView },
  Failed: { error: Schema.String },
})
export type Topup = typeof Topup.Type

export const Model = Schema.Struct({
  network: Schema.String,
  exchange: Schema.Boolean,
  addressCopy: AddressCopy,
  deposit: DepositData.schema,
  topupAssets: TopupAssetsData.schema,
  topupForm: TopupForm,
  topup: Topup,
  checkingTopup: Schema.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE
export const Message = defineMessageUnion({
  EnteredPage: { needsDeposit: Schema.Boolean, canTopup: Schema.Boolean },
  Refreshed: { receiveVisible: Schema.Boolean },
  SelectedNetwork: { network: Schema.String },
  ClickedExchange: {},
  ClickedWalletAddress: {},
  ClickedRetryAssets: {},
  ClickedCopyAddress: { address: Schema.String },
  CompletedCopyAddress: { address: Schema.String },
  FailedCopyAddress: { address: Schema.String },
  ClickedGetDepositAddress: {},
  SucceededLoadDeposit: { deposit: DepositAddressView },
  FailedLoadDeposit: { problem: Problem },
  SucceededLoadTopupAssets: { chains: Schema.Array(TopupChain) },
  FailedLoadTopupAssets: { problem: Problem },
  SelectedTopupAsset: { assetId: Schema.String },
  UpdatedTopupAmount: { value: Schema.String },
  UpdatedTopupRefund: { value: Schema.String },
  SubmittedTopupQuote: {},
  SucceededQuoteTopup: { quote: TopupQuoteView },
  FailedQuoteTopup: { problem: Problem },
  SucceededCheckTopup: { quote: TopupQuoteView },
  FailedCheckTopup: { problem: Problem },
  ClickedNewTopup: {},
})
export type Message = typeof Message.Type
export const OutMessage = defineMessageUnion({ EndedSession: {}, FundsArrived: {} })
export type OutMessage = typeof OutMessage.Type
export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>
export const init = (): Update.Return<Model, Message, Resources> => ({
  model: {
    network: 'stellar',
    exchange: false,
    addressCopy: AddressCopy.Idle(),
    deposit: DepositData.Idle(),
    topupAssets: TopupAssetsData.Idle(),
    topupForm: { chain: '', assetId: '', amount: '', refundTo: '' },
    topup: Topup.Editing(),
    checkingTopup: false,
  },
})

// COMMAND
export const LoadDeposit = Command.define('LoadDeposit', {
  messages: [Message.SucceededLoadDeposit, Message.FailedLoadDeposit],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const deposit = yield* backend.depositAddress
    return Message.SucceededLoadDeposit({ deposit })
  }).pipe(recoverProblem(problem => Message.FailedLoadDeposit({ problem }))),
})

export const LoadTopupAssets = Command.define('LoadTopupAssets', {
  messages: [Message.SucceededLoadTopupAssets, Message.FailedLoadTopupAssets],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const chains = yield* backend.topupAssets
    return Message.SucceededLoadTopupAssets({ chains })
  }).pipe(recoverProblem(problem => Message.FailedLoadTopupAssets({ problem }))),
})

export const QuoteTopup = Command.define('QuoteTopup', {
  args: { originAsset: Schema.String, amount: Schema.String, refundTo: Schema.String },
  messages: [Message.SucceededQuoteTopup, Message.FailedQuoteTopup],
  execute: ({ originAsset, amount, refundTo }) =>
    Effect.gen(function* () {
      const backend = yield* Backend
      const quote = yield* backend.topupQuote({ origin_asset: originAsset, amount, refund_to: refundTo })
      return Message.SucceededQuoteTopup({ quote })
    }).pipe(recoverProblem(problem => Message.FailedQuoteTopup({ problem }))),
})

export const CheckTopup = Command.define('CheckTopup', {
  args: { id: Schema.String },
  messages: [Message.SucceededCheckTopup, Message.FailedCheckTopup],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const backend = yield* Backend
      const quote = yield* backend.topupStatus(id)
      return Message.SucceededCheckTopup({ quote })
    }).pipe(recoverProblem(problem => Message.FailedCheckTopup({ problem }))),
})

export const CopyAddress = Command.define('CopyAddress', {
  args: { address: Schema.String },
  messages: [Message.CompletedCopyAddress, Message.FailedCopyAddress],
  execute: ({ address }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(address)).pipe(
      Effect.as(Message.CompletedCopyAddress({ address })),
      Effect.orElseSucceed(() => Message.FailedCopyAddress({ address })),
    ),
})

// UPDATE
const startDeposit = (model: Model): Update.Return<Model, Message, Resources> =>
  Option.match(AsyncData.revalidateOrLoad(model.deposit), {
    onNone: () => ({ model }),
    onSome: nextDeposit => ({
      model: modifyFields(model, { deposit: () => nextDeposit }),
      commands: [LoadDeposit()],
    }),
  })

export const isTopupWaiting = (model: Model): boolean =>
  Topup.match<boolean>(model.topup, {
    Editing: () => false,
    Quoting: () => false,
    Quoted: ({ quote }) => quote.status === 'pending' || quote.status === 'processing',
    Failed: () => false,
  })

const firstAsset = (chains: ReadonlyArray<TopupChain>, chain: string): string =>
  Option.match(
    Option.flatMap(
      Array.findFirst(chains, each => each.chain === chain),
      each => Array.head(each.assets),
    ),
    { onNone: () => '', onSome: asset => asset.id },
  )

const loadAssets = (model: Model): Update.Return<Model, Message, Resources> =>
  Option.match(AsyncData.revalidateOrLoad(model.topupAssets), {
    onNone: () => ({ model }),
    onSome: nextAssets => ({
      model: modifyFields(model, { topupAssets: () => nextAssets }),
      commands: [LoadTopupAssets()],
    }),
  })

const refresh = (model: Model, receiveVisible: boolean): UpdateReturn => {
  const deposit: UpdateReturn = receiveVisible && AsyncData.isSuccess(model.deposit) ? startDeposit(model) : { model }
  if (!isTopupWaiting(model) || model.checkingTopup || !Topup.guards.Quoted(model.topup)) return deposit
  return {
    model: modifyFields(deposit.model, { checkingTopup: () => true }),
    commands: [...(deposit.commands ?? []), CheckTopup({ id: model.topup.quote.id })],
  }
}
const canEdit = (model: Model): boolean => Topup.guards.Editing(model.topup) || Topup.guards.Failed(model.topup)
const switchNetwork = (model: Model, network: string): UpdateReturn => {
  if (
    Topup.guards.Quoting(model.topup) ||
    (!canEdit(model) && network !== 'stellar' && network !== model.topupForm.chain)
  )
    return { model }
  const changed = network !== 'stellar' && network !== model.topupForm.chain
  return {
    model: modifyFields(model, {
      network: () => network,
      addressCopy: () => AddressCopy.Idle(),
      topupForm: form =>
        changed
          ? modifyFields(form, {
              chain: () => network,
              refundTo: () => '',
              assetId: () =>
                AsyncData.matchData(model.topupAssets, {
                  onEmpty: () => '',
                  onFailure: () => '',
                  onData: chains => firstAsset(chains, network),
                }),
            })
          : form,
    }),
  }
}
export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: ({ needsDeposit, canTopup }) =>
      Update.combine(model, [
        stepModel =>
          canTopup && AsyncData.isIdle(stepModel.topupAssets) ? loadAssets(stepModel) : { model: stepModel },
        stepModel =>
          needsDeposit && AsyncData.isIdle(stepModel.deposit) ? startDeposit(stepModel) : { model: stepModel },
      ]),
    Refreshed: ({ receiveVisible }) => refresh(model, receiveVisible),
    SelectedNetwork: ({ network }) => switchNetwork(model, network),
    ClickedExchange: () =>
      startDeposit(modifyFields(model, { exchange: () => true, addressCopy: () => AddressCopy.Idle() })),
    ClickedWalletAddress: () => ({
      model: modifyFields(model, { exchange: () => false, addressCopy: () => AddressCopy.Idle() }),
    }),
    ClickedRetryAssets: () => loadAssets(model),
    ClickedCopyAddress: ({ address }) =>
      AddressCopy.guards.Copying(model.addressCopy)
        ? { model }
        : {
            model: modifyFields(model, { addressCopy: () => AddressCopy.Copying({ address }) }),
            commands: [CopyAddress({ address })],
          },
    CompletedCopyAddress: ({ address }) =>
      AddressCopy.guards.Copying(model.addressCopy) && model.addressCopy.address === address
        ? { model: modifyFields(model, { addressCopy: () => AddressCopy.Copied() }) }
        : { model },
    FailedCopyAddress: ({ address }) =>
      AddressCopy.guards.Copying(model.addressCopy) && model.addressCopy.address === address
        ? { model: modifyFields(model, { addressCopy: () => AddressCopy.Failed() }) }
        : { model },
    ClickedGetDepositAddress: () => (AsyncData.isLoading(model.deposit) ? { model } : startDeposit(model)),
    SucceededLoadDeposit: ({ deposit }) => ({
      model: modifyFields(model, { deposit: () => DepositData.Success({ data: deposit }) }),
    }),
    FailedLoadDeposit: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({ model, outMessage: OutMessage.EndedSession() }),
        Failed: ({ error }) => ({ model: modifyFields(model, { deposit: () => DepositData.Failure({ error }) }) }),
      }),
    SucceededLoadTopupAssets: ({ chains }) => {
      const chain =
        model.topupForm.chain === ''
          ? Option.getOrElse(
              Option.map(Array.head(chains), each => each.chain),
              () => '',
            )
          : model.topupForm.chain
      return {
        model: modifyFields(model, {
          topupAssets: () => TopupAssetsData.Success({ data: chains }),
          topupForm: form =>
            modifyFields(form, {
              chain: () => chain,
              assetId: assetId => (assetId === '' ? firstAsset(chains, chain) : assetId),
            }),
        }),
      }
    },
    FailedLoadTopupAssets: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({ model, outMessage: OutMessage.EndedSession() }),
        Failed: ({ error }) => ({
          model: modifyFields(model, { topupAssets: () => TopupAssetsData.Failure({ error }) }),
        }),
      }),
    SelectedTopupAsset: ({ assetId }) =>
      !canEdit(model)
        ? { model }
        : {
            model: modifyFields(model, { topupForm: form => modifyFields(form, { assetId: () => assetId }) }),
          },
    UpdatedTopupAmount: ({ value }) =>
      !canEdit(model)
        ? { model }
        : {
            model: modifyFields(model, { topupForm: form => modifyFields(form, { amount: () => value }) }),
          },
    UpdatedTopupRefund: ({ value }) =>
      !canEdit(model)
        ? { model }
        : {
            model: modifyFields(model, { topupForm: form => modifyFields(form, { refundTo: () => value }) }),
          },
    SubmittedTopupQuote: () =>
      Topup.match<UpdateReturn>(model.topup, {
        Quoting: () => ({ model }),
        Quoted: () => ({ model }),
        Editing: () => requestQuote(model),
        Failed: () => requestQuote(model),
      }),
    SucceededQuoteTopup: ({ quote: received }) => ({
      model: modifyFields(model, {
        topup: () => Topup.Quoted({ quote: received }),
        addressCopy: () => AddressCopy.Idle(),
      }),
    }),
    FailedQuoteTopup: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({ model, outMessage: OutMessage.EndedSession() }),
        Failed: ({ error }) => ({ model: modifyFields(model, { topup: () => Topup.Failed({ error }) }) }),
      }),
    SucceededCheckTopup: ({ quote }) => ({
      model: modifyFields(model, { topup: () => Topup.Quoted({ quote }), checkingTopup: () => false }),
      ...(quote.status === 'arrived' ? { outMessage: OutMessage.FundsArrived() } : {}),
    }),
    FailedCheckTopup: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({
          model: modifyFields(model, { checkingTopup: () => false }),
          outMessage: OutMessage.EndedSession(),
        }),
        Failed: () => ({ model: modifyFields(model, { checkingTopup: () => false }) }),
      }),
    ClickedNewTopup: () =>
      isTopupWaiting(model) || Topup.guards.Quoting(model.topup)
        ? { model }
        : {
            model: modifyFields(model, {
              topup: () => Topup.Editing(),
              topupForm: form => modifyFields(form, { amount: () => '' }),
              addressCopy: () => AddressCopy.Idle(),
            }),
          },
  })
const formReady = (form: TopupForm): boolean =>
  form.assetId !== '' &&
  Number.isFinite(Number(form.amount)) &&
  Number(form.amount) > 0 &&
  form.refundTo.trim().length >= 20
const requestQuote = (model: Model): UpdateReturn =>
  model.network === 'stellar' || !formReady(model.topupForm)
    ? { model }
    : {
        model: modifyFields(model, { topup: () => Topup.Quoting() }),
        commands: [
          QuoteTopup({
            originAsset: model.topupForm.assetId,
            amount: model.topupForm.amount.trim(),
            refundTo: model.topupForm.refundTo.trim(),
          }),
        ],
      }

export const informEntered = (overview: Overview) => (model: Model) =>
  update(
    model,
    Message.EnteredPage({
      needsDeposit:
        overview.deposits_available !== false &&
        (overview.wallet.account_status === 'awaiting_deposit' || model.exchange),
      canTopup: isMainnet(overview.network ?? overview.wallet.network) && overview.deposits_available !== false,
    }),
  )
export const informRefresh = (receiveVisible: boolean) => (model: Model) =>
  update(model, Message.Refreshed({ receiveVisible }))

// VIEW
const addressQr = (
  address: string,
  h: HtmlBuilder<Message>,
  label = 'QR code of your wallet address',
  testid = 'address-qr',
): Html => {
  const maybeModules = Option.fromNullishOr(qrModules(address))
  return Option.match(maybeModules, {
    onNone: () => h.empty,
    onSome: modules =>
      h.svg(
        [
          h.ViewBox(`0 0 ${modules.length + 8} ${modules.length + 8}`),
          h.Role('img'),
          h.AriaLabel(label),
          h.DataAttribute('testid', testid),
          h.Class('aspect-square h-auto w-40 max-w-full shrink-0 rounded-xl bg-white ring-1 ring-line sm:w-44'),
        ],
        [h.path([h.D(qrPath(modules)), h.Fill('#14171a'), h.ShapeRendering('crispEdges')])],
      ),
  })
}

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

const CHAIN_NAMES: Readonly<Record<string, string>> = {
  base: 'Base',
  sol: 'Solana',
  eth: 'Ethereum',
  arb: 'Arbitrum',
  pol: 'Polygon',
  op: 'Optimism',
  bsc: 'BNB Chain',
  avax: 'Avalanche',
  near: 'NEAR',
  btc: 'Bitcoin',
  tron: 'Tron',
  ton: 'TON',
  sui: 'Sui',
  aptos: 'Aptos',
}

const chainName = (chain: string): string => CHAIN_NAMES[chain] ?? `${chain.charAt(0).toUpperCase()}${chain.slice(1)}`

const refundPlaceholder = (chain: string): string =>
  chain === 'sol'
    ? 'Your Solana address'
    : chain === 'btc'
      ? 'Your Bitcoin address'
      : '0x… (your address on that chain)'

const TOPUP_NEXT = 'Receiving from other chains is unavailable on this network. You can receive USDC on Stellar.'

/** On a network without a deposit router, or when Nod answers topup_unavailable, the tab says what comes next. */
const topupNext = (h: HtmlBuilder<Message>): Html =>
  h.p([h.DataAttribute('testid', 'topup-status'), h.Class('text-sm text-muted')], [TOPUP_NEXT])

const isUnavailable = (error: string): boolean => error.startsWith('topup_unavailable')

const selectField = (
  label: string,
  id: string,
  testid: string,
  value: string,
  options: ReadonlyArray<readonly [value: string, label: string]>,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-col gap-1.5')],
    [
      h.label([h.For(id), h.Class('text-sm font-semibold text-ink')], [label]),
      h.select(
        [h.Id(id), h.DataAttribute('testid', testid), h.Class(INPUT), h.OnChange(onChange)],
        Array.map(options, ([optionValue, optionLabel]) =>
          h.option([h.Value(optionValue), h.Selected(optionValue === value)], [optionLabel]),
        ),
      ),
    ],
  )

const topupFormView = (chains: ReadonlyArray<TopupChain>, model: Model, h: HtmlBuilder<Message>): Html => {
  const form = model.topupForm
  const assets = Option.match(
    Array.findFirst(chains, each => each.chain === form.chain),
    { onNone: () => [], onSome: each => each.assets },
  )
  const symbol = Option.match(
    Array.findFirst(assets, asset => asset.id === form.assetId),
    { onNone: () => '', onSome: asset => asset.symbol },
  )
  const busy = Topup.match<boolean>(model.topup, {
    Editing: () => false,
    Quoting: () => true,
    Quoted: () => false,
    Failed: () => false,
  })
  const ready = formReady(form)
  return h.form(
    [h.Class('flex flex-col gap-4'), h.OnSubmit(Message.SubmittedTopupQuote())],
    [
      h.fieldset(
        [h.Disabled(busy), h.Class('flex min-w-0 flex-col gap-4')],
        [
          h.p([h.Class('text-sm text-ink')], ['Choose what to send. It arrives as USDC in your Nod wallet.']),
          h.div(
            [h.Class('grid gap-4')],
            [
              selectField(
                'Asset',
                'topup-asset',
                'topup-asset',
                form.assetId,
                Array.map(assets, asset => [asset.id, asset.symbol] as const),
                assetId => Message.SelectedTopupAsset({ assetId }),
                h,
              ),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-1.5')],
            [
              h.label(
                [h.For('topup-amount'), h.Class('text-sm font-semibold text-ink')],
                [symbol === '' ? 'Amount' : `Amount in ${symbol}`],
              ),
              h.input([
                h.Id('topup-amount'),
                h.Type('text'),
                h.InputMode('decimal'),
                h.Autocomplete('off'),
                h.Placeholder('5'),
                h.Value(form.amount),
                h.DataAttribute('testid', 'topup-amount'),
                h.Class(`${INPUT} tabular-nums`),
                h.OnInput(value => Message.UpdatedTopupAmount({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-1.5')],
            [
              h.label(
                [h.For('topup-refund'), h.Class('text-sm font-semibold text-ink')],
                [`Refund address on ${chainName(form.chain)}`],
              ),
              h.input([
                h.Id('topup-refund'),
                h.Type('text'),
                h.Autocomplete('off'),
                h.Spellcheck(false),
                h.Attribute('autocapitalize', 'none'),
                h.Placeholder(refundPlaceholder(form.chain)),
                h.Value(form.refundTo),
                h.AriaDescribedBy('topup-refund-hint'),
                h.DataAttribute('testid', 'topup-refund'),
                h.Class(`${INPUT} font-mono text-sm`),
                h.OnInput(value => Message.UpdatedTopupRefund({ value })),
              ]),
              h.p(
                [h.Id('topup-refund-hint'), h.Class('text-sm text-muted')],
                ['If the swap cannot finish, it goes back here. Required.'],
              ),
            ],
          ),
          h.button(
            [
              h.Type('submit'),
              h.Disabled(busy || !ready),
              h.DataAttribute('testid', 'topup-get-address'),
              h.Class(`${BUTTON_PRIMARY} self-start`),
            ],
            [busy ? 'Getting an address…' : 'Get deposit address'],
          ),
        ],
      ),
    ],
  )
}

const twoDigits = (value: number): string => String(value).padStart(2, '0')

/** "29:41 left to send, until 21:45 UTC"; "Time is up" once the deadline passed; the deadline alone before the clock ticks. */
const countdownText = (deadline: string, maybeNowMs: Option.Option<number>): string => {
  const until = `until ${dateTime(deadline).replace(/^\w+ \d+ \w+, /u, '')}`
  return Option.match(maybeNowMs, {
    onNone: () => `Send it ${until}`,
    onSome: nowMs => {
      const left = Math.floor((Date.parse(deadline) - nowMs) / 1000)
      return left <= 0
        ? 'Time is up: anything sent now goes back to your refund address'
        : `${Math.floor(left / 60)}:${twoDigits(left % 60)} left to send, ${until}`
    },
  })
}

const topupStatusLine = (quote: TopupQuoteView, overview: Overview, h: HtmlBuilder<Message>): Html => {
  const explorer = overview.explorer_base ?? 'https://stellar.expert/explorer/public'
  const line = (tone: 'quiet' | 'busy' | 'good' | 'bad', children: ReadonlyArray<Html | string>): Html =>
    h.p(
      [
        h.DataAttribute('testid', 'topup-status'),
        h.DataAttribute('status', quote.status),
        h.Role('status'),
        h.Class(
          `flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-danger' : 'text-ink'}`,
        ),
      ],
      [
        h.span([
          h.AriaHidden(true),
          h.Class(
            `size-2 shrink-0 rounded-full ${tone === 'good' ? 'bg-good' : tone === 'bad' ? 'bg-danger' : tone === 'busy' ? 'bg-accent' : 'bg-muted'}`,
          ),
        ]),
        ...children,
      ],
    )
  const chain = chainName(quote.origin_chain)
  return Match.value(quote.status).pipe(
    Match.withReturnType<Html>(),
    Match.when('pending', () => line('quiet', [`Waiting for your ${quote.asset} on ${chain}.`])),
    Match.when('processing', () => line('busy', [`Received on ${chain}; swapping it to USDC on Stellar.`])),
    Match.when('arrived', () =>
      line('good', [
        `Arrived: about ${quote.amount_out} USDC is in your wallet.`,
        ...Option.match(Option.fromNullishOr(quote.sweep_tx), {
          onNone: () => [],
          onSome: hash => [
            h.a(
              [
                h.Href(`${explorer}/tx/${hash}`),
                h.Target('_blank'),
                h.Rel('noreferrer'),
                h.Class(`${LINK} font-mono text-[0.8125rem]`),
              ],
              [`${shortAddress(hash)} ↗`],
            ),
          ],
        }),
      ]),
    ),
    Match.when('failed', () =>
      line('bad', [`The swap did not go through. NEAR Intents sends your ${quote.asset} back to the refund address.`]),
    ),
    Match.when('expired', () =>
      line('quiet', ['The 30 minutes are up. Anything sent late goes back to your refund address.']),
    ),
    Match.exhaustive,
  )
}

const topupQuoted = (
  quote: TopupQuoteView,
  overview: Overview,
  model: Model,
  nowMs: Option.Option<number>,
  h: HtmlBuilder<Message>,
): Html => {
  const waiting = quote.status === 'pending'
  return h.div(
    [h.Class('flex flex-col gap-4')],
    [
      ...(waiting
        ? [
            h.div(
              [h.Class('flex flex-col gap-5 sm:flex-row sm:items-start')],
              [
                addressQr(
                  quote.pay_to,
                  h,
                  `QR code of the address to pay on ${chainName(quote.origin_chain)}`,
                  'topup-qr',
                ),
                h.div(
                  [h.Class('flex min-w-0 flex-col gap-3')],
                  [
                    h.p([h.Class('text-sm text-ink')], [`Send exactly`]),
                    h.p(
                      [
                        h.DataAttribute('testid', 'topup-amount-in'),
                        h.Class(`${FIGURE} text-3xl leading-none text-ink`),
                      ],
                      [`${quote.amount_in} ${quote.asset}`],
                    ),
                    h.p([h.Class('text-sm text-ink')], [`on ${chainName(quote.origin_chain)} to this address:`]),
                    h.p(
                      [
                        h.DataAttribute('testid', 'topup-address'),
                        h.Class('break-all rounded-xl bg-mist px-3 py-2 font-mono text-sm text-ink select-all'),
                      ],
                      [quote.pay_to],
                    ),
                    h.div(
                      [h.Class('flex flex-wrap items-center gap-3')],
                      [
                        h.button(
                          [
                            h.Type('button'),
                            h.OnClick(Message.ClickedCopyAddress({ address: quote.pay_to })),
                            h.Class(BUTTON_SECONDARY),
                          ],
                          [
                            AddressCopy.match(model.addressCopy, {
                              Idle: () => 'Copy address',
                              Copying: () => 'Copying…',
                              Copied: () => 'Copied',
                              Failed: () => 'Copy address',
                            }),
                          ],
                        ),
                        h.span(
                          [h.AriaLive('polite'), h.Class('text-sm text-muted')],
                          [
                            AddressCopy.match(model.addressCopy, {
                              Idle: () => '',
                              Copying: () => '',
                              Copied: () => 'Paste it in the wallet you send from.',
                              Failed: () => 'Copying is blocked here; select the address and copy it.',
                            }),
                          ],
                        ),
                      ],
                    ),
                    h.p(
                      [h.DataAttribute('testid', 'topup-countdown'), h.Class('text-sm tabular-nums text-muted')],
                      [countdownText(quote.deadline, nowMs)],
                    ),
                  ],
                ),
              ],
            ),
          ]
        : [
            h.p(
              [h.Class('text-sm text-ink')],
              [
                h.span(
                  [h.DataAttribute('testid', 'topup-amount-in'), h.Class(`${FIGURE} text-xl`)],
                  [`${quote.amount_in} ${quote.asset}`],
                ),
                ` from ${chainName(quote.origin_chain)}`,
              ],
            ),
          ]),
      ...(quote.status === 'arrived'
        ? []
        : [
            h.p(
              [h.Class('text-sm text-ink')],
              [
                'It arrives as about ',
                h.span([h.Class('font-semibold tabular-nums')], [`${quote.amount_out} USDC`]),
                ' in your Nod wallet.',
              ],
            ),
          ]),
      topupStatusLine(quote, overview, h),
      ...(waiting || quote.status === 'processing'
        ? []
        : [
            h.button(
              [h.Type('button'), h.OnClick(Message.ClickedNewTopup()), h.Class(`${BUTTON_SECONDARY} self-start`)],
              ['Receive again'],
            ),
          ]),
    ],
  )
}

const otherChain = (overview: Overview, model: Model, nowMs: Option.Option<number>, h: HtmlBuilder<Message>): Html =>
  overview.deposits_available === false
    ? topupNext(h)
    : AsyncData.match(model.topupAssets, {
        onIdle: () => loadingRow(h),
        onLoading: () => loadingRow(h),
        onFailure: error => (isUnavailable(error) ? topupNext(h) : errorRow(error, h)),
        onRefreshing: chains => topupBody(chains, overview, model, nowMs, h),
        onStale: ({ data }) => topupBody(data, overview, model, nowMs, h),
        onSuccess: chains => topupBody(chains, overview, model, nowMs, h),
      })

const topupBody = (
  chains: ReadonlyArray<TopupChain>,
  overview: Overview,
  model: Model,
  nowMs: Option.Option<number>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(chains, {
    onEmpty: () => topupNext(h),
    onNonEmpty: () =>
      Topup.match<Html>(model.topup, {
        Editing: () => topupFormView(chains, model, h),
        Quoting: () => topupFormView(chains, model, h),
        Quoted: ({ quote }) => topupQuoted(quote, overview, model, nowMs, h),
        Failed: ({ error }) =>
          isUnavailable(error)
            ? topupNext(h)
            : h.div([h.Class('flex flex-col gap-4')], [errorRow(error, h), topupFormView(chains, model, h)]),
      }),
  })

const addressView = (address: string, model: Model, h: HtmlBuilder<Message>, deposit = false): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-col items-center gap-3')],
    [
      addressQr(address, h, 'QR code of your receiving address', deposit ? 'deposit-qr' : 'address-qr'),
      h.p(
        [
          h.DataAttribute('testid', deposit ? 'deposit-address' : 'wallet-address'),
          h.Class('w-full rounded-lg bg-mist p-3 font-mono text-sm [overflow-wrap:anywhere] select-all'),
        ],
        [address],
      ),
      h.button(
        [h.Type('button'), h.OnClick(Message.ClickedCopyAddress({ address })), h.Class(`${BUTTON_PRIMARY} w-full`)],
        [AddressCopy.guards.Copied(model.addressCopy) ? 'Copied' : 'Copy address'],
      ),
      h.p(
        [
          h.Role('status'),
          h.AriaLive('polite'),
          h.Class(AddressCopy.guards.Failed(model.addressCopy) ? 'text-sm text-muted' : 'sr-only'),
        ],
        [
          AddressCopy.match(model.addressCopy, {
            Idle: () => '',
            Copying: () => '',
            Copied: () => 'Address copied.',
            Failed: () => 'Clipboard unavailable. Select the address above and copy it.',
          }),
        ],
      ),
    ],
  )

const stellarView = (overview: Overview, model: Model, h: HtmlBuilder<Message>): Html => {
  const awaiting = overview.wallet.account_status === 'awaiting_deposit'
  const useDeposit = awaiting || model.exchange
  const network = overview.network ?? overview.wallet.network
  return h.div(
    [h.Class('flex flex-col gap-5')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-3')],
        [
          h.p([h.Class('font-medium')], ['USDC']),
          badge(networkLabel(network), isMainnet(network) ? 'good' : 'warn', h),
        ],
      ),
      useDeposit
        ? h.div(
            [h.Class('flex flex-col gap-4')],
            [
              h.p(
                [h.Class('text-sm text-muted')],
                [
                  awaiting
                    ? 'Send USDC to this deposit address. Your wallet opens when the first deposit arrives. No memo needed.'
                    : 'Send USDC from your exchange or Stellar wallet. No memo needed. It arrives in your Nod wallet.',
                ],
              ),
              overview.deposits_available === false
                ? h.p(
                    [h.Role('status'), h.Class('text-sm text-muted')],
                    ['Deposit addresses are unavailable on this network.'],
                  )
                : AsyncData.matchData(model.deposit, {
                    onEmpty: () =>
                      h.p(
                        [h.Role('status'), h.Class('text-sm text-muted')],
                        ['Preparing your deposit address (about 15 s)…'],
                      ),
                    onFailure: error =>
                      h.div(
                        [h.Class('flex flex-col gap-3')],
                        [
                          errorRow(error, h),
                          h.button(
                            [
                              h.Type('button'),
                              h.OnClick(Message.ClickedGetDepositAddress()),
                              h.Class(BUTTON_SECONDARY),
                            ],
                            ['Try again'],
                          ),
                        ],
                      ),
                    onData: deposit =>
                      h.div(
                        [h.Class('flex flex-col gap-5')],
                        [addressView(deposit.address, model, h, true), depositFacts(deposit, h)],
                      ),
                  }),
              !awaiting
                ? h.button(
                    [
                      h.Type('button'),
                      h.OnClick(Message.ClickedWalletAddress()),
                      h.Class(`${LINK} inline-flex min-h-11 items-center self-start text-sm`),
                    ],
                    ['Use my wallet address'],
                  )
                : h.empty,
            ],
          )
        : h.div(
            [h.Class('flex flex-col gap-5')],
            [
              h.p(
                [h.Class('text-sm text-muted')],
                ['Send USDC on Stellar from a compatible wallet, such as Freighter.'],
              ),
              addressView(overview.wallet.contract_id, model, h),
              h.div(
                [h.Class('flex flex-wrap items-center justify-between gap-x-4 gap-y-1')],
                [
                  h.a(
                    [
                      h.Href(explorerAccountUrl(network, overview.wallet.contract_id, overview.explorer_base)),
                      h.Target('_blank'),
                      h.Rel('noopener noreferrer'),
                      h.Class(`${LINK} inline-flex min-h-11 items-center self-start text-sm`),
                    ],
                    ['View on explorer'],
                  ),
                  overview.deposits_available === false
                    ? h.empty
                    : h.button(
                        [
                          h.Type('button'),
                          h.OnClick(Message.ClickedExchange()),
                          h.Class(`${LINK} inline-flex min-h-11 items-center self-start text-sm`),
                        ],
                        ['Sending from an exchange?'],
                      ),
                ],
              ),
            ],
          ),
    ],
  )
}

const networkView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const chains = AsyncData.matchData(model.topupAssets, {
    onEmpty: () => [],
    onFailure: () => [],
    onData: data => data,
  })
  const locked = !canEdit(model)
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.label([h.For('receive-network'), h.Class('text-sm font-medium')], ['From network']),
      h.select(
        [
          h.Id('receive-network'),
          h.Class(INPUT),
          h.Disabled(Topup.guards.Quoting(model.topup)),
          h.OnChange(network => Message.SelectedNetwork({ network })),
        ],
        [
          h.option([h.Value('stellar'), h.Selected(model.network === 'stellar')], ['Stellar']),
          ...Array.map(chains, chain =>
            h.option(
              [
                h.Value(chain.chain),
                h.Selected(model.network === chain.chain),
                h.Disabled(locked && chain.chain !== model.topupForm.chain),
              ],
              [chainName(chain.chain)],
            ),
          ),
        ],
      ),
    ],
  )
}

type ViewInputs = Readonly<{ overview: Overview; nowMs: Option.Option<number>; backHref: string }>
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { overview, nowMs, backHref }, h): Html =>
  h.section(
    [h.Class('mx-auto flex w-full max-w-[480px] flex-col gap-4 py-2')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-3')],
        [
          h.h1([h.Class('font-display text-3xl font-bold tracking-[-0.025em]')], ['Receive']),
          h.a(
            [h.Href(backHref || homeRouter()), h.Class(`${LINK} inline-flex min-h-11 items-center text-sm`)],
            ['Back'],
          ),
        ],
      ),
      networkView(model, h),
      model.network === 'stellar' ? stellarView(overview, model, h) : otherChain(overview, model, nowMs, h),
      model.network === 'stellar' && isTopupWaiting(model)
        ? h.div(
            [
              h.Role('status'),
              h.Class('flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm'),
            ],
            [
              h.p([], ['A transfer from another chain is in progress.']),
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.SelectedNetwork({ network: model.topupForm.chain })),
                  h.Class(BUTTON_SECONDARY),
                ],
                ['View transfer'],
              ),
            ],
          )
        : h.empty,
      !isMainnet(overview.network ?? overview.wallet.network) || overview.deposits_available === false
        ? topupNext(h)
        : AsyncData.matchData(model.topupAssets, {
            onEmpty: () => h.p([h.Role('status'), h.Class('text-sm text-muted')], ['Loading other networks…']),
            onFailure: error =>
              h.div(
                [h.Class('flex flex-col items-start gap-3')],
                [
                  isUnavailable(error) ? topupNext(h) : errorRow(error, h),
                  h.button(
                    [h.Type('button'), h.OnClick(Message.ClickedRetryAssets()), h.Class(BUTTON_SECONDARY)],
                    ['Retry networks'],
                  ),
                ],
              ),
            onData: chains => (Array.isReadonlyArrayEmpty(chains) ? topupNext(h) : h.empty),
          }),
    ],
  ),
)
