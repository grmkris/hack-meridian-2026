import { Duration, Effect, Layer, Match, Option, Schema, Stream } from 'effect'
import { Command, Port, Runtime, Subscription, type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import type { PaymentView } from '@hm/protocol'

import {
  appNameOf,
  decodeCapabilities,
  decodeToolInput,
  mergeAppearance,
  paymentOf,
  shownOfResult,
  toolNameOf,
  walletOf,
} from './decode'
import { Host } from './host'
import { Message } from './message'
import { Bridge, LinkState, Model, Poll, Shown, Surface } from './model'
import { isSettled, settledSentence } from './phase'
import { view } from './view'

/**
 * The Nod card: one Foldkit program for every view, embedded by `entry.ts`. The host's notifications arrive on
 * inbound ports as unknown JSON and are decoded here; everything the card asks of the host goes through `Host`.
 */

// PORT

export const ports = {
  inbound: {
    connected: Port.inbound(
      Schema.Struct({ capabilities: Schema.Unknown, context: Schema.Unknown, hostInfo: Schema.Unknown }),
    ),
    connectFailed: Port.inbound(Schema.String),
    hostContext: Port.inbound(Schema.Unknown),
    toolInput: Port.inbound(Schema.Unknown),
    toolResult: Port.inbound(Schema.Unknown),
  },
}

// INIT

export const Flags = Schema.Struct({ surface: Surface, isVisible: Schema.Boolean })
export type Flags = typeof Flags.Type

export const init: Runtime.ElementInit<Model, Message, Flags, Host> = flags => ({
  model: {
    surface: flags.surface,
    bridge: Bridge.Connecting(),
    maybeAppName: Option.none(),
    appearance: { maybeTheme: Option.none(), variables: {}, isFullscreen: flags.surface === 'Home' },
    isVisible: flags.isVisible,
    maybeToolName: Option.none(),
    toolInput: {
      maybeUrl: Option.none(),
      maybeServerUrl: Option.none(),
      maybeTool: Option.none(),
      maybeMaxAmount: Option.none(),
      maybeReason: Option.none(),
    },
    shown: Shown.Waiting(),
    poll: Poll.Idle(),
    pollCount: 0,
    maybePollError: Option.none(),
    maybeSharedContext: Option.none(),
    link: LinkState.Idle(),
  },
})

// COMMAND

export const PollPayment = Command.define('PollPayment', {
  args: { paymentId: Schema.String },
  messages: [Message.SucceededPollPayment, Message.FailedPollPayment],
  execute: ({ paymentId }) =>
    Effect.gen(function* () {
      const host = yield* Host
      const reply = yield* host.callTool('payment_status', { payment_id: paymentId })
      return Message.SucceededPollPayment({ reply })
    }).pipe(Effect.catch(error => Effect.succeed(Message.FailedPollPayment({ reason: error.reason })))),
})

export const PollWallet = Command.define('PollWallet', {
  messages: [Message.SucceededPollWallet, Message.FailedPollWallet],
  execute: Effect.gen(function* () {
    const host = yield* Host
    const reply = yield* host.callTool('wallet_overview', {})
    return Message.SucceededPollWallet({ reply })
  }).pipe(Effect.catch(error => Effect.succeed(Message.FailedPollWallet({ reason: error.reason })))),
})

export const OpenLink = Command.define('OpenLink', {
  args: { url: Schema.String },
  messages: [Message.SucceededOpenLink, Message.FailedOpenLink],
  execute: ({ url }) =>
    Effect.gen(function* () {
      const host = yield* Host
      yield* host.openLink(url)
      return Message.SucceededOpenLink()
    }).pipe(Effect.catch(error => Effect.succeed(Message.FailedOpenLink({ url, reason: error.reason })))),
})

export const ShareContext = Command.define('ShareContext', {
  args: { text: Schema.String },
  messages: [Message.CompletedShareContext],
  execute: ({ text }) =>
    Effect.gen(function* () {
      const host = yield* Host
      yield* host.updateModelContext(text)
      return Message.CompletedShareContext()
    }).pipe(Effect.orElseSucceed(() => Message.CompletedShareContext())),
})

// POLLING

/** What the card is waiting on, if anything: a payment that has not settled, or the Home wallet. */
type PollTarget = { readonly _tag: 'Payment'; readonly paymentId: string } | { readonly _tag: 'Wallet' }

const unsettled = (payment: PaymentView): Option.Option<PollTarget> =>
  isSettled(payment) ? Option.none() : Option.some({ _tag: 'Payment', paymentId: payment.payment_id })

export const pollTargetOf = (model: Model): Option.Option<PollTarget> =>
  model.surface === 'Home'
    ? Option.some({ _tag: 'Wallet' })
    : Shown.match<Option.Option<PollTarget>>(model.shown, {
        Waiting: () => Option.none(),
        ToolFailed: () => Option.none(),
        Unrecognised: () => Option.none(),
        Payment: ({ payment }) => unsettled(payment),
        Purchase: ({ purchase, maybePayment }) =>
          Option.match(maybePayment, {
            onSome: unsettled,
            onNone: () =>
              purchase.status === 'requires_approval' && purchase.payment_id !== null
                ? Option.some({ _tag: 'Payment', paymentId: purchase.payment_id })
                : Option.none(),
          }),
        Wallet: () => Option.none(),
        AllowanceLink: () => Option.none(),
        Revoked: () => Option.none(),
      })

const canCallTools = (model: Model): boolean =>
  Bridge.match<boolean>(model.bridge, {
    Connecting: () => false,
    Connected: ({ capabilities }) => capabilities.canCallTools,
    Unavailable: () => false,
  })

/** Fast polls for the first two minutes of a payment, then slower; the wallet every ten seconds. */
const FAST_POLLS = 40
const FAST = Duration.seconds(3)
const SLOW = Duration.seconds(10)

const Schedule = Schema.Literals(['Never', 'Fast', 'Slow'])
type Schedule = typeof Schedule.Type

const scheduleOf = (model: Model): Schedule => {
  if (!model.isVisible || !canCallTools(model)) {
    return 'Never'
  }
  return Option.match(pollTargetOf(model), {
    onNone: () => 'Never',
    onSome: target => (target._tag === 'Payment' && model.pollCount < FAST_POLLS ? 'Fast' : 'Slow'),
  })
}

const ticks = (every: Duration.Duration) => Stream.tick(every).pipe(Stream.drop(1), Stream.map(Message.TickedPoll))

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Host>

/** Start one poll unless one is already out: polls never overlap. */
const startPoll = (model: Model): UpdateReturn => {
  if (model.poll._tag === 'InFlight' || !canCallTools(model)) {
    return { model }
  }
  return Option.match(pollTargetOf(model), {
    onNone: () => ({ model }),
    onSome: target => ({
      model: modifyFields(model, { poll: () => Poll.InFlight() }),
      commands: [target._tag === 'Payment' ? PollPayment({ paymentId: target.paymentId }) : PollWallet()],
    }),
  })
}

const paymentShown = (shown: Shown, payment: PaymentView): Shown =>
  Shown.match<Shown>(shown, {
    Waiting: () => Shown.Payment({ payment }),
    ToolFailed: () => shown,
    Unrecognised: () => shown,
    Payment: () => Shown.Payment({ payment }),
    Purchase: ({ purchase }) => Shown.Purchase({ purchase, maybePayment: Option.some(payment) }),
    Wallet: () => shown,
    AllowanceLink: () => shown,
    Revoked: () => shown,
  })

/** Tell the AI once when a payment the card was watching settles; the same sentence is never sent twice. */
const shareSettled = (model: Model, wasSettled: boolean, payment: PaymentView): UpdateReturn => {
  const text = settledSentence(payment)
  const isNew = Option.match(model.maybeSharedContext, { onNone: () => true, onSome: shared => shared !== text })
  if (wasSettled || !isSettled(payment) || !isNew) {
    return { model }
  }
  return {
    model: modifyFields(model, { maybeSharedContext: () => Option.some(text) }),
    commands: [ShareContext({ text })],
  }
}

const wasSettled = (model: Model): boolean => Option.isNone(pollTargetOf(model))

const afterPoll = (model: Model): Model =>
  modifyFields(model, { poll: () => Poll.Idle(), pollCount: count => count + 1 })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ConnectedToHost: ({ capabilities, context, hostInfo }) => {
      const connected = modifyFields(model, {
        bridge: () => Bridge.Connected({ capabilities: decodeCapabilities(capabilities) }),
        maybeAppName: () => appNameOf(hostInfo),
        appearance: appearance => mergeAppearance(appearance, context),
        maybeToolName: maybeToolName => Option.orElse(toolNameOf(context), () => maybeToolName),
      })
      return connected.surface === 'Home' && connected.shown._tag === 'Waiting'
        ? startPoll(connected)
        : { model: connected }
    },
    FailedToConnect: ({ reason }) => ({ model: modifyFields(model, { bridge: () => Bridge.Unavailable({ reason }) }) }),
    ReceivedHostContext: ({ context }) => ({
      model: modifyFields(model, {
        appearance: appearance => mergeAppearance(appearance, context),
        maybeToolName: maybeToolName => Option.orElse(toolNameOf(context), () => maybeToolName),
      }),
    }),
    ReceivedToolInput: ({ params }) => ({ model: modifyFields(model, { toolInput: () => decodeToolInput(params) }) }),
    ReceivedToolResult: ({ params }) => ({
      model: modifyFields(model, {
        shown: () => shownOfResult(params, model.maybeToolName),
        pollCount: () => 0,
        maybePollError: () => Option.none(),
      }),
    }),
    ChangedVisibility: ({ isVisible }) => {
      const changed = modifyFields(model, { isVisible: () => isVisible })
      return isVisible && !model.isVisible ? startPoll(changed) : { model: changed }
    },
    TickedPoll: () => startPoll(model),
    SucceededPollPayment: ({ reply }) =>
      Option.match(reply.isError ? Option.none() : paymentOf(reply.structured), {
        onNone: () => ({
          model: modifyFields(afterPoll(model), {
            maybePollError: () =>
              Option.some(reply.text === '' ? 'Nod sent something the card cannot read.' : reply.text),
          }),
        }),
        onSome: payment =>
          shareSettled(
            modifyFields(afterPoll(model), {
              shown: shown => paymentShown(shown, payment),
              maybePollError: () => Option.none(),
            }),
            wasSettled(model),
            payment,
          ),
      }),
    FailedPollPayment: ({ reason }) => ({
      model: modifyFields(afterPoll(model), { maybePollError: () => Option.some(reason) }),
    }),
    SucceededPollWallet: ({ reply }) =>
      Option.match(reply.isError ? Option.none() : walletOf(reply.structured), {
        onNone: () => ({
          model: modifyFields(afterPoll(model), {
            maybePollError: () =>
              Option.some(reply.text === '' ? 'Nod sent something the card cannot read.' : reply.text),
          }),
        }),
        onSome: overview => ({
          model: modifyFields(afterPoll(model), {
            shown: () => Shown.Wallet({ overview }),
            maybePollError: () => Option.none(),
          }),
        }),
      }),
    FailedPollWallet: ({ reason }) => ({
      model: modifyFields(afterPoll(model), { maybePollError: () => Option.some(reason) }),
    }),
    ClickedOpenLink: ({ url }) => ({
      model: modifyFields(model, { link: () => LinkState.Opening({ url }) }),
      commands: [OpenLink({ url })],
    }),
    SucceededOpenLink: () => ({ model: modifyFields(model, { link: () => LinkState.Idle() }) }),
    FailedOpenLink: ({ url, reason }) => ({
      model: modifyFields(model, { link: () => LinkState.Failed({ url, reason }) }),
    }),
    CompletedShareContext: () => ({ model }),
  })

// SUBSCRIPTION

const visibilityChanges = Stream.fromEventListener(document, 'visibilitychange').pipe(
  Stream.map(() => Message.ChangedVisibility({ isVisible: document.visibilityState === 'visible' })),
)

export const subscriptions = Subscription.make<Model, Message, Host>()(entry => ({
  connected: Port.subscriptionEntry(ports.inbound.connected, ({ capabilities, context, hostInfo }) =>
    Message.ConnectedToHost({ capabilities, context, hostInfo }),
  ),
  connectFailed: Port.subscriptionEntry(ports.inbound.connectFailed, reason => Message.FailedToConnect({ reason })),
  hostContext: Port.subscriptionEntry(ports.inbound.hostContext, context => Message.ReceivedHostContext({ context })),
  toolInput: Port.subscriptionEntry(ports.inbound.toolInput, params => Message.ReceivedToolInput({ params })),
  toolResult: Port.subscriptionEntry(ports.inbound.toolResult, params => Message.ReceivedToolResult({ params })),
  visibility: Subscription.persistentEntry(visibilityChanges),
  poll: entry(
    { schedule: Schedule },
    {
      modelToDependencies: model => ({ schedule: scheduleOf(model) }),
      dependenciesToStream: ({ schedule }) =>
        Match.value(schedule).pipe(
          Match.when('Never', () => Stream.empty),
          Match.when('Fast', () => ticks(FAST)),
          Match.when('Slow', () => ticks(SLOW)),
          Match.exhaustive,
        ),
    },
  ),
}))

// PROGRAM

export const makeElement = (container: HTMLElement, flags: Flags, host: Layer.Layer<Host>) =>
  Runtime.makeElement({
    Model,
    Flags,
    flags: Effect.succeed(flags),
    init,
    update,
    view,
    subscriptions,
    ports,
    container,
    resources: host,
  })
