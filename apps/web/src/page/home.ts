import { Array, Clock, Effect, Match, Option, Schema } from 'effect'
import { AsyncData, Command, Dom, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  Backend,
  DepositAddressView,
  type GrantView,
  Overview,
  type PendingApproval,
  type Resources,
  TopupChain,
  TopupQuoteView,
} from '../backend'
import { allowanceHelp, allowanceState, clientUrl } from '../connection'
import { dateTime, explorerAccountUrl, isMainnet, networkLabel, shortAddress, usdc } from '../format'
import { Problem, recoverProblem } from '../problem'
import { connectionsRouter, receiptsRouter } from '../route'
import { disclosure } from '../view/disclosure'
import { usdcNumber } from '../view/money'
import { qrModules, qrPath } from '../view/qr'
import { receiptRow } from '../view/receipt'
import {
  BUTTON_NOD,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  FIGURE,
  INPUT,
  LINK,
  badge,
  emptyRow,
  errorRow,
  loadingRow,
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

export const SetupTarget = Schema.Literals(['Prompt', 'Url'])
export type SetupTarget = typeof SetupTarget.Type
export const SetupCopy = defineTaggedUnion({
  Idle: {},
  Copying: { target: SetupTarget },
  Copied: { target: SetupTarget },
  Failed: { target: SetupTarget },
})
export type SetupCopy = typeof SetupCopy.Type

export const setupPrompt = (connectorUrl: string): string =>
  `Add Nod as an MCP server: ${connectorUrl}. Help me finish authorization and verify that its tools are available.`

/** Add money has two ways in: on Stellar (the wallet and deposit addresses), or from another chain (NEAR Intents). */
export const AddMoneyTab = defineTaggedUnion({
  OnStellar: {},
  OtherChain: {},
})
export type AddMoneyTab = typeof AddMoneyTab.Type

export const TopupAssetsData = AsyncData.Schema(Schema.Array(TopupChain), Schema.String)
type TopupAssetsData = typeof TopupAssetsData.schema.Type

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
  overview: OverviewData.schema,
  addressCopy: AddressCopy,
  deposit: DepositData.schema,
  addMoneyTab: AddMoneyTab,
  topupAssets: TopupAssetsData.schema,
  topupForm: TopupForm,
  topup: Topup,
  /** Wall time for allowance expiry and the top-up deadline. */
  maybeNowMs: Schema.Option(Schema.Finite),
  setupCopy: SetupCopy,
  setupOpen: Schema.Boolean,
  fundingOpen: Schema.Boolean,
  activityOpen: Schema.Boolean,
  needsFundingFocus: Schema.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  EnteredPage: {},
  ClickedRefresh: {},
  SucceededLoadOverview: { overview: Overview, nowMs: Schema.Finite },
  FailedLoadOverview: { problem: Problem },
  ClickedCopyAddress: { address: Schema.String },
  CompletedCopyAddress: {},
  FailedCopyAddress: {},
  ClickedGetDepositAddress: {},
  SucceededLoadDeposit: { deposit: DepositAddressView },
  FailedLoadDeposit: { problem: Problem },
  ClickedAddMoneyTab: { tab: AddMoneyTab },
  SucceededLoadTopupAssets: { chains: Schema.Array(TopupChain) },
  FailedLoadTopupAssets: { problem: Problem },
  SelectedTopupChain: { chain: Schema.String },
  SelectedTopupAsset: { assetId: Schema.String },
  UpdatedTopupAmount: { value: Schema.String },
  UpdatedTopupRefund: { value: Schema.String },
  SubmittedTopupQuote: {},
  SucceededQuoteTopup: { quote: TopupQuoteView },
  FailedQuoteTopup: { problem: Problem },
  SucceededCheckTopup: { quote: TopupQuoteView },
  FailedCheckTopup: { problem: Problem },
  TickedTopupClock: { nowMs: Schema.Finite },
  ClickedNewTopup: {},
  RequestedFunding: {},
  ClickedCloseFunding: {},
  CompletedFocusFunding: {},
  CompletedFocusTopupButton: {},
  ToggledSetup: { isOpen: Schema.Boolean },
  ToggledActivity: { isOpen: Schema.Boolean },
  ClickedCopySetup: { target: SetupTarget, connectorUrl: Schema.String },
  CompletedCopySetup: { target: SetupTarget },
  FailedCopySetup: { target: SetupTarget },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ EndedSession: {} })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Update.Return<Model, Message, Resources> => ({
  model: {
    overview: OverviewData.Idle(),
    addressCopy: AddressCopy.Idle(),
    deposit: DepositData.Idle(),
    addMoneyTab: AddMoneyTab.OnStellar(),
    topupAssets: TopupAssetsData.Idle(),
    topupForm: { chain: '', assetId: '', amount: '', refundTo: '' },
    topup: Topup.Editing(),
    maybeNowMs: Option.none(),
    setupCopy: SetupCopy.Idle(),
    setupOpen: false,
    fundingOpen: false,
    activityOpen: false,
    needsFundingFocus: false,
  },
})

// COMMAND

export const LoadOverview = Command.define('LoadOverview', {
  messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const overview = yield* backend.overview
    const nowMs = yield* Clock.currentTimeMillis
    return Message.SucceededLoadOverview({ overview, nowMs })
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
      Effect.as(Message.CompletedCopyAddress()),
      Effect.orElseSucceed(() => Message.FailedCopyAddress()),
    ),
})

export const CopySetup = Command.define('CopySetup', {
  args: { target: SetupTarget, connectorUrl: Schema.String },
  messages: [Message.CompletedCopySetup, Message.FailedCopySetup],
  execute: ({ target, connectorUrl }) =>
    Effect.tryPromise(() =>
      navigator.clipboard.writeText(target === 'Prompt' ? setupPrompt(connectorUrl) : connectorUrl),
    ).pipe(
      Effect.as(Message.CompletedCopySetup({ target })),
      Effect.orElseSucceed(() => Message.FailedCopySetup({ target })),
    ),
})

export const FocusFunding = Command.define('FocusFunding', {
  messages: [Message.CompletedFocusFunding],
  execute: Dom.scrollIntoViewAfterPaint('#add-money', { block: 'start' }).pipe(
    Effect.andThen(Dom.focus('#add-money', { preventScroll: true })),
    Effect.ignore,
    Effect.as(Message.CompletedFocusFunding()),
  ),
})

export const FocusTopupButton = Command.define('FocusTopupButton', {
  messages: [Message.CompletedFocusTopupButton],
  execute: Dom.focus('#top-up-button').pipe(Effect.ignore, Effect.as(Message.CompletedFocusTopupButton())),
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

/** A quote still waiting for the deposit or the swap: the countdown runs and every refresh reads its status. */
export const isTopupWaiting = (model: Model): boolean =>
  Topup.match<boolean>(model.topup, {
    Editing: () => false,
    Quoting: () => false,
    Quoted: ({ quote }) => quote.status === 'pending' || quote.status === 'processing',
    Failed: () => false,
  })

const checkTopupCommands = (model: Model): ReadonlyArray<ReturnType<typeof CheckTopup>> =>
  Topup.match<ReadonlyArray<ReturnType<typeof CheckTopup>>>(model.topup, {
    Editing: () => [],
    Quoting: () => [],
    Quoted: ({ quote }) => (isTopupWaiting(model) ? [CheckTopup({ id: quote.id })] : []),
    Failed: () => [],
  })

/** Entering Home (and each live refresh) reloads the overview and reads a waiting top-up's status. */
const enter = (model: Model): UpdateReturn => {
  const load = startLoad(model)
  return { ...load, commands: [...(load.commands ?? []), ...checkTopupCommands(model)] }
}

const firstAsset = (chains: ReadonlyArray<TopupChain>, chain: string): string =>
  Option.match(
    Option.flatMap(
      Array.findFirst(chains, each => each.chain === chain),
      each => Array.head(each.assets),
    ),
    { onNone: () => '', onSome: asset => asset.id },
  )

const openOtherChain = (model: Model): UpdateReturn =>
  Option.match(AsyncData.revalidateOrLoad(model.topupAssets), {
    onNone: () => ({ model }),
    onSome: nextAssets => ({
      model: modifyFields(model, { topupAssets: () => nextAssets }),
      commands: [LoadTopupAssets()],
    }),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () => enter(model),
    ClickedRefresh: () => startLoad(model),
    SucceededLoadOverview: ({ overview, nowMs }) => {
      const loaded = modifyFields(model, {
        overview: () => OverviewData.Success({ data: overview }),
        maybeNowMs: () => Option.some(nowMs),
        needsFundingFocus: () => false,
      })
      const deposit: UpdateReturn = wantsDeposit(overview) ? startDeposit(loaded) : { model: loaded }
      return {
        ...deposit,
        commands: [...(deposit.commands ?? []), ...(model.needsFundingFocus ? [FocusFunding()] : [])],
      }
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
    ClickedAddMoneyTab: ({ tab }) => {
      const switched = modifyFields(model, { addMoneyTab: () => tab, addressCopy: () => AddressCopy.Idle() })
      return AddMoneyTab.match<UpdateReturn>(tab, {
        OnStellar: () => ({ model: switched }),
        OtherChain: () => openOtherChain(switched),
      })
    },
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
    SelectedTopupChain: ({ chain }) => ({
      model: modifyFields(model, {
        topupForm: form =>
          modifyFields(form, {
            chain: () => chain,
            assetId: () =>
              AsyncData.match(model.topupAssets, {
                onIdle: () => '',
                onLoading: () => '',
                onRefreshing: chains => firstAsset(chains, chain),
                onStale: ({ data }) => firstAsset(data, chain),
                onSuccess: chains => firstAsset(chains, chain),
                onFailure: () => '',
              }),
            refundTo: () => '',
          }),
      }),
    }),
    SelectedTopupAsset: ({ assetId }) => ({
      model: modifyFields(model, { topupForm: form => modifyFields(form, { assetId: () => assetId }) }),
    }),
    UpdatedTopupAmount: ({ value }) => ({
      model: modifyFields(model, { topupForm: form => modifyFields(form, { amount: () => value }) }),
    }),
    UpdatedTopupRefund: ({ value }) => ({
      model: modifyFields(model, { topupForm: form => modifyFields(form, { refundTo: () => value }) }),
    }),
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
    SucceededCheckTopup: ({ quote: received }) => {
      const checked = modifyFields(model, { topup: () => Topup.Quoted({ quote: received }) })
      return received.status === 'arrived' ? startLoad(checked) : { model: checked }
    },
    FailedCheckTopup: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({ model, outMessage: OutMessage.EndedSession() }),
        Failed: () => ({ model }),
      }),
    TickedTopupClock: ({ nowMs }) => ({ model: modifyFields(model, { maybeNowMs: () => Option.some(nowMs) }) }),
    ClickedNewTopup: () => ({
      model: modifyFields(model, {
        topup: () => Topup.Editing(),
        topupForm: form => modifyFields(form, { amount: () => '' }),
        addressCopy: () => AddressCopy.Idle(),
      }),
    }),
    RequestedFunding: () => {
      const hasOverview = AsyncData.matchData(model.overview, {
        onEmpty: () => false,
        onFailure: () => false,
        onData: () => true,
      })
      return {
        model: modifyFields(model, { fundingOpen: () => true, needsFundingFocus: () => !hasOverview }),
        commands: hasOverview ? [FocusFunding()] : [],
      }
    },
    ClickedCloseFunding: () => ({
      model: modifyFields(model, { fundingOpen: () => false, needsFundingFocus: () => false }),
      commands: [FocusTopupButton()],
    }),
    CompletedFocusFunding: () => ({ model }),
    CompletedFocusTopupButton: () => ({ model }),
    ToggledSetup: ({ isOpen }) => ({ model: modifyFields(model, { setupOpen: () => isOpen }) }),
    ToggledActivity: ({ isOpen }) => ({ model: modifyFields(model, { activityOpen: () => isOpen }) }),
    ClickedCopySetup: ({ target, connectorUrl }) =>
      SetupCopy.guards.Copying(model.setupCopy)
        ? { model }
        : {
            model: modifyFields(model, { setupCopy: () => SetupCopy.Copying({ target }) }),
            commands: [CopySetup({ target, connectorUrl })],
          },
    CompletedCopySetup: ({ target }) => ({
      model: modifyFields(model, { setupCopy: () => SetupCopy.Copied({ target }) }),
    }),
    FailedCopySetup: ({ target }) => ({
      model: modifyFields(model, { setupCopy: () => SetupCopy.Failed({ target }) }),
    }),
  })

const requestQuote = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { topup: () => Topup.Quoting() }),
  commands: [
    QuoteTopup({
      originAsset: model.topupForm.assetId,
      amount: model.topupForm.amount.trim(),
      refundTo: model.topupForm.refundTo.trim(),
    }),
  ],
})

export const informEntered = (model: Model) => update(model, Message.EnteredPage())

export const informFundingRequested = (model: Model) => update(model, Message.RequestedFunding())

/** The top-up countdown's clock, from the root's subscription: the wall time now. */
export const informClock = (nowMs: number) => (model: Model) => update(model, Message.TickedTopupClock({ nowMs }))

// VIEW

const walletColumn = (overview: Overview, model: Model, h: HtmlBuilder<Message>): Html => {
  const network = overview.network ?? overview.wallet.network
  const amount = usdcNumber(overview.balances.usdc)
  return h.section(
    [h.AriaLabel('Wallet balance'), h.Class('min-w-0 [container-type:inline-size]')],
    [
      h.p([h.Class('text-sm text-muted')], ['Wallet balance']),
      h.div(
        [h.Class('mt-2 flex flex-wrap items-center justify-between gap-4')],
        [
          h.p(
            [
              h.DataAttribute('testid', 'wallet-balance'),
              h.Class(
                `flex max-w-full flex-wrap items-baseline gap-x-2 font-sans font-semibold leading-tight tracking-[-0.035em] tabular-nums ${amount.length > 10 ? 'text-[clamp(1rem,8cqi,2rem)]' : 'text-[2.75rem]'}`,
              ),
            ],
            [
              h.span([h.Class('[overflow-wrap:anywhere]')], [amount]),
              h.span([h.Class('text-sm font-medium tracking-normal text-muted')], [' USDC']),
            ],
          ),
          h.button(
            [
              h.Id('top-up-button'),
              h.Type('button'),
              h.OnClick(Message.RequestedFunding()),
              h.AriaExpanded(model.fundingOpen),
              ...(model.fundingOpen ? [h.AriaControls('add-money')] : []),
              h.Class(BUTTON_SECONDARY),
            ],
            ['Top up'],
          ),
        ],
      ),
      h.p(
        [h.Class('mt-3 text-sm leading-relaxed text-muted')],
        [
          overview.wallet.account_status === 'awaiting_deposit'
            ? 'Ready for your first deposit. You can connect an app now.'
            : 'Your money, ready when you need it.',
        ],
      ),
      h.a(
        [
          h.Href(explorerAccountUrl(network, overview.wallet.contract_id, overview.explorer_base)),
          h.Target('_blank'),
          h.Rel('noopener noreferrer'),
          h.Title(overview.wallet.contract_id),
          h.Class(`${LINK} mt-3 inline-flex min-h-11 items-center font-mono text-xs`),
        ],
        [shortAddress(overview.wallet.contract_id)],
      ),
    ],
  )
}

const APP_MARKS = [
  { id: 'openai', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'grok', label: 'Grok' },
  { id: 'grokbot', label: 'Grok Bot' },
]

const setupArtifact = (target: SetupTarget, connectorUrl: string, copy: SetupCopy, h: HtmlBuilder<Message>): Html => {
  const isPrompt = target === 'Prompt'
  const label = isPrompt ? 'Setup prompt' : 'MCP URL'
  const value = isPrompt ? setupPrompt(connectorUrl) : connectorUrl
  const copied = SetupCopy.guards.Copied(copy) && copy.target === target
  const failed = SetupCopy.guards.Failed(copy) && copy.target === target
  return h.div(
    [h.Class('min-w-0 border-t border-line py-5')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-3')],
        [
          h.h3([h.Class('text-base font-medium')], [label]),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCopySetup({ target, connectorUrl })),
              h.Disabled(SetupCopy.guards.Copying(copy)),
              h.AriaLabel(isPrompt ? 'Copy setup prompt' : 'Copy MCP URL'),
              h.Class(BUTTON_SECONDARY),
            ],
            [copied ? 'Copied' : 'Copy'],
          ),
        ],
      ),
      h.p(
        [h.Class('mt-2 text-sm text-muted')],
        [
          isPrompt
            ? 'Paste into an agent that can add connectors for you.'
            : 'Paste into your app’s connector settings.',
        ],
      ),
      h.p([h.Class('mt-3 select-text text-sm leading-relaxed [overflow-wrap:anywhere]')], [value]),
      failed
        ? h.p(
            [h.Role('status'), h.Class('mt-2 text-sm text-danger')],
            ['Clipboard unavailable. Select the text above and copy it.'],
          )
        : h.empty,
    ],
  )
}

const setupView = (model: Model, connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('min-w-0')],
    [
      h.h2(
        [h.Class('font-display text-[clamp(1.5rem,4vw,2rem)] font-bold leading-tight tracking-[-0.025em]')],
        ['Use Nod in your chat.'],
      ),
      h.p([h.Class('mt-3 mb-5 text-sm text-muted')], ['Connect now. Add money whenever you’re ready.']),
      setupArtifact('Prompt', connectorUrl, model.setupCopy, h),
      setupArtifact('Url', connectorUrl, model.setupCopy, h),
      h.ul(
        [h.AriaLabel('AI apps'), h.Class('flex flex-wrap items-center gap-4 pt-1')],
        Array.map(APP_MARKS, app =>
          h.keyed('li')(
            app.id,
            [h.Title(app.label)],
            [h.img([h.Src(`/apps/${app.id}.svg`), h.Alt(app.label), h.Class('size-5 shrink-0 opacity-65')])],
          ),
        ),
      ),
      h.p(
        [h.Role('status'), h.AriaLive('polite'), h.Class('sr-only')],
        [
          SetupCopy.guards.Copied(model.setupCopy)
            ? `${model.setupCopy.target === 'Prompt' ? 'Setup prompt' : 'MCP URL'} copied.`
            : '',
        ],
      ),
    ],
  )

const allowanceRow = (grant: GrantView, model: Model, isSingle: boolean, h: HtmlBuilder<Message>): Html => {
  const state = allowanceState(grant, model.maybeNowMs)
  return h.keyed('li')(
    grant.connection_id,
    [h.Class('min-w-0 py-5 first:pt-0 last:pb-0')],
    [
      h.p([h.Class('text-sm font-medium [overflow-wrap:anywhere]')], [grant.client_name]),
      state === 'ready'
        ? h.div(
            [h.Class('mt-2')],
            [
              h.p(
                [h.Class('flex flex-wrap items-baseline gap-x-2 gap-y-1')],
                [
                  h.span(
                    [
                      h.Class(
                        `font-sans font-semibold tracking-[-0.025em] text-accent tabular-nums [overflow-wrap:anywhere] ${isSingle ? 'text-3xl' : 'text-xl'}`,
                      ),
                    ],
                    [usdc(grant.remaining)],
                  ),
                  h.span([h.Class('text-sm text-muted')], ['left to spend']),
                ],
              ),
              h.p(
                [h.Class('mt-2 text-sm text-muted [overflow-wrap:anywhere]')],
                [`of ${usdc(grant.total)}, until ${dateTime(grant.valid_until ?? '')}`],
              ),
            ],
          )
        : h.p([h.Class('mt-2 text-sm text-muted')], [allowanceHelp[state]]),
      Option.match(clientUrl(grant.client_domain), {
        onNone: () => h.p([h.Class('mt-3 text-sm text-muted')], [`Return to ${grant.client_name} to use Nod.`]),
        onSome: url =>
          h.a(
            [
              h.Href(url),
              h.Target('_blank'),
              h.Rel('noopener noreferrer'),
              h.Class(
                `${isSingle ? BUTTON_PRIMARY : LINK} mt-4 inline-flex min-h-11 items-center [overflow-wrap:anywhere]`,
              ),
            ],
            [`Open ${grant.client_name}`],
          ),
      }),
    ],
  )
}

const connectionView = (overview: Overview, model: Model, connectorUrl: string, h: HtmlBuilder<Message>): Html => {
  const connected = Array.filter(overview.grants, grant => grant.connection_status === 'active')
  return Array.match(connected, {
    onEmpty: () => setupView(model, connectorUrl, h),
    onNonEmpty: grants =>
      h.section(
        [h.Class('min-w-0'), h.AriaLabel('Connected apps')],
        [
          h.h2([h.Class('mb-5 font-display text-2xl font-bold tracking-[-0.025em]')], ['Continue in your chat.']),
          h.ul(
            [h.Class('divide-y divide-line')],
            Array.map(grants, grant => allowanceRow(grant, model, grants.length === 1, h)),
          ),
          h.p(
            [h.Class('mt-4 text-sm leading-relaxed text-muted')],
            [
              grants.length === 1
                ? 'Payments share this allowance. Spending above it needs your passkey.'
                : 'Each app has its own cumulative allowance. Spending above it needs your passkey.',
            ],
          ),
          h.a(
            [h.Href(connectionsRouter()), h.Class(`${LINK} mt-2 inline-flex min-h-11 items-center text-sm`)],
            ['Manage permissions'],
          ),
          h.div(
            [h.Class('mt-5 border-t border-line pt-3')],
            [
              disclosure(
                'connect-another',
                'Connect another app',
                model.setupOpen,
                isOpen => Message.ToggledSetup({ isOpen }),
                () => setupView(model, connectorUrl, h),
                h,
              ),
            ],
          ),
        ],
      ),
  })
}

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

/** The Stellar way in: the wallet's own address (Freighter) and, where a router exists, the deposit address. */
const onStellar = (
  overview: Overview,
  addressCopy: AddressCopy,
  deposit: DepositData,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const network = overview.network ?? overview.wallet.network
  const address = overview.wallet.contract_id
  return [
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
                overview.deposits_available === true
                  ? 'You can also send USDC straight to the wallet address from Freighter.'
                  : 'Works from wallets that can send to contract addresses (Freighter). Deposit addresses for exchanges are next.',
              ],
            ),
          ],
        ),
      ],
    ),
    ...(overview.deposits_available === false ? [] : [depositBlock(overview, deposit, h)]),
  ]
}

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

const TOPUP_NEXT = 'Top-ups from other chains are next here. For now, add USDC on Stellar.'

/** On a network without a deposit router, or when Nod answers topup_unavailable, the tab says what comes next. */
const topupNext = (h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.DataAttribute('testid', 'topup-status'), h.Class('rounded-2xl bg-mist px-4 py-5 text-sm text-ink')],
    [TOPUP_NEXT],
  )

const isUnavailable = (error: string): boolean =>
  error.startsWith('topup_unavailable') || error.startsWith('Nod did not answer') || error.includes('Not Found')

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
  const ready = form.assetId !== '' && Number(form.amount) > 0 && form.refundTo.trim().length >= 20
  return h.form(
    [h.Class('flex flex-col gap-4'), h.OnSubmit(Message.SubmittedTopupQuote())],
    [
      h.p(
        [h.Class('text-sm text-ink')],
        [
          'Pay from another chain and it arrives as USDC in this wallet. NEAR Intents swaps it and sends it to your deposit address; Nod sweeps it in.',
        ],
      ),
      h.div(
        [h.Class('grid gap-4 sm:grid-cols-2')],
        [
          selectField(
            'From',
            'topup-chain',
            'topup-chain',
            form.chain,
            Array.map(chains, each => [each.chain, chainName(each.chain)] as const),
            chain => Message.SelectedTopupChain({ chain }),
            h,
          ),
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
        [busy ? 'Getting an address…' : 'Get address'],
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
            `size-2 shrink-0 rounded-full ${tone === 'good' ? 'bg-good' : tone === 'bad' ? 'bg-danger' : tone === 'busy' ? 'bg-accent motion-safe:animate-pulse' : 'bg-muted'}`,
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

const topupQuoted = (quote: TopupQuoteView, overview: Overview, model: Model, h: HtmlBuilder<Message>): Html => {
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
                              Copied: () => 'Paste it in the wallet you send from.',
                              Failed: () => 'Copying is blocked here; select the address and copy it.',
                            }),
                          ],
                        ),
                      ],
                    ),
                    h.p(
                      [h.DataAttribute('testid', 'topup-countdown'), h.Class('text-sm tabular-nums text-muted')],
                      [countdownText(quote.deadline, model.maybeNowMs)],
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
              ['Top up again'],
            ),
          ]),
    ],
  )
}

const otherChain = (overview: Overview, model: Model, h: HtmlBuilder<Message>): Html =>
  overview.deposits_available === false
    ? topupNext(h)
    : AsyncData.match(model.topupAssets, {
        onIdle: () => loadingRow(h),
        onLoading: () => loadingRow(h),
        onFailure: error => (isUnavailable(error) ? topupNext(h) : errorRow(error, h)),
        onRefreshing: chains => topupBody(chains, overview, model, h),
        onStale: ({ data }) => topupBody(data, overview, model, h),
        onSuccess: chains => topupBody(chains, overview, model, h),
      })

const topupBody = (
  chains: ReadonlyArray<TopupChain>,
  overview: Overview,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(chains, {
    onEmpty: () => topupNext(h),
    onNonEmpty: () =>
      Topup.match<Html>(model.topup, {
        Editing: () => topupFormView(chains, model, h),
        Quoting: () => topupFormView(chains, model, h),
        Quoted: ({ quote }) => topupQuoted(quote, overview, model, h),
        Failed: ({ error }) =>
          isUnavailable(error)
            ? topupNext(h)
            : h.div([h.Class('flex flex-col gap-4')], [errorRow(error, h), topupFormView(chains, model, h)]),
      }),
  })

const ADD_MONEY_TABS: ReadonlyArray<Readonly<{ tab: AddMoneyTab; label: string; testid: string }>> = [
  { tab: AddMoneyTab.OnStellar(), label: 'On Stellar', testid: 'stellar-tab' },
  { tab: AddMoneyTab.OtherChain(), label: 'From another chain', testid: 'topup-tab' },
]

const addMoneyTabs = (selected: AddMoneyTab, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('tablist'),
      h.AriaLabel('How to add money'),
      h.Class('mb-5 inline-flex gap-1 self-start rounded-full bg-mist p-1'),
    ],
    Array.map(ADD_MONEY_TABS, ({ tab, label, testid }) => {
      const isSelected = tab._tag === selected._tag
      return h.button(
        [
          h.Type('button'),
          h.Role('tab'),
          h.Id(`add-money-${testid}`),
          h.AriaSelected(isSelected),
          h.AriaControls('add-money-panel'),
          h.DataAttribute('testid', testid),
          h.OnClick(Message.ClickedAddMoneyTab({ tab })),
          h.Class(
            `inline-flex min-h-10 touch-manipulation select-none items-center rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              isSelected ? 'bg-paper text-ink shadow-[0_0_0_1px_var(--color-line)]' : 'text-muted hover:text-ink'
            }`,
          ),
        ],
        [label],
      )
    }),
  )

const addMoneyPanel = (overview: Overview, model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Id('add-money'),
      h.Tabindex(-1),
      h.DataAttribute('testid', 'add-money'),
      h.Class(
        'scroll-mt-6 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent',
      ),
    ],
    [
      panel(
        'Top up',
        [
          h.div(
            [h.Class('flex flex-col')],
            [
              addMoneyTabs(model.addMoneyTab, h),
              h.div(
                [
                  h.Id('add-money-panel'),
                  h.Role('tabpanel'),
                  h.AriaLabelledBy(
                    `add-money-${AddMoneyTab.match(model.addMoneyTab, { OnStellar: () => 'stellar-tab', OtherChain: () => 'topup-tab' })}`,
                  ),
                  h.Class('flex flex-col gap-5'),
                ],
                AddMoneyTab.match<ReadonlyArray<Html>>(model.addMoneyTab, {
                  OnStellar: () => onStellar(overview, model.addressCopy, model.deposit, h),
                  OtherChain: () => [otherChain(overview, model, h)],
                }),
              ),
            ],
          ),
          h.button(
            [h.Type('button'), h.OnClick(Message.ClickedCloseFunding()), h.Class(`${BUTTON_SECONDARY} mt-5`)],
            ['Close top up'],
          ),
        ],
        h,
      ),
    ],
  )

type ViewInputs = Readonly<{ connectorUrl: string }>

const loadedView = (overview: Overview, model: Model, connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-8')],
    [
      h.div(
        [
          h.Class(
            'grid min-w-0 items-start gap-10 py-4 md:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] md:gap-16 md:py-8',
          ),
        ],
        [walletColumn(overview, model, h), connectionView(overview, model, connectorUrl, h)],
      ),
      ...Array.match(overview.pending, { onEmpty: () => [], onNonEmpty: () => [approvalsPanel(overview, h)] }),
      model.fundingOpen ? addMoneyPanel(overview, model, h) : h.empty,
      !model.fundingOpen && isTopupWaiting(model)
        ? h.p(
            [h.Role('status'), h.Class('text-sm text-muted')],
            ['Your top-up is in progress. Open Top up to see its status.'],
          )
        : h.empty,
      h.div(
        [h.Class('border-t border-line pt-3')],
        [
          disclosure(
            'recent-activity',
            'Recent activity',
            model.activityOpen,
            isOpen => Message.ToggledActivity({ isOpen }),
            () => activityPanel(overview, h),
            h,
          ),
        ],
      ),
    ],
  )

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { connectorUrl }, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      h.h1([h.Class('sr-only')], ['Home']),
      AsyncData.matchData(model.overview, {
        onEmpty: () => loadingRow(h),
        onFailure: error =>
          h.div(
            [h.Class('flex flex-col items-start gap-4')],
            [
              errorRow(error, h),
              h.button(
                [h.Type('button'), h.OnClick(Message.ClickedRefresh()), h.Class(BUTTON_SECONDARY)],
                ['Try again'],
              ),
            ],
          ),
        onData: overview => loadedView(overview, model, connectorUrl, h),
      }),
    ],
  ),
)
