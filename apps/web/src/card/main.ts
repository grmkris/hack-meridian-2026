import { Array, Clock, Duration, Effect, Layer, Match, Option, Random, Schema, Stream } from 'effect'
import { Command, Port, Runtime, Subscription, type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import type { PaymentView, RequestView } from '@hm/protocol'

import {
  appNameOf,
  decodeCapabilities,
  decodeToolInput,
  mergeAppearance,
  paymentOf,
  requestOf,
  requestsOf,
  shownOfResult,
  toolNameOf,
  walletOf,
} from './decode'
import { Host, type ToolReply } from './host'
import { Message } from './message'
import { Bridge, LinkState, Model, Poll, RequestAction, RequestActionKind, Shown, Surface } from './model'
import { isSettled, settledSentence } from './phase'
import { view } from './view'

/**
 * The Nod card: one Foldkit program for every view, embedded by `boot.ts`. The host's notifications arrive on
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
    appearance: { maybeTheme: Option.none(), variables: {}, isFullscreen: false },
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
    maybeActivePayment: Option.none(),
    requestAction: RequestAction.Idle(),
    maybeSelectedRequestId: Option.none(),
    inbox: [],
  },
})

// COMMAND

const UNREADABLE = 'Nod sent something the card cannot read.'

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

export const PollInbox = Command.define('PollInbox', {
  messages: [Message.SucceededPollInbox, Message.FailedPollInbox],
  execute: Effect.gen(function* () {
    const host = yield* Host
    const reply = yield* host.callTool('requests_list', { direction: 'incoming', status: 'open' })
    return Message.SucceededPollInbox({ reply })
  }).pipe(Effect.catch(error => Effect.succeed(Message.FailedPollInbox({ reason: error.reason })))),
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

const KEY_SPACE = 2 ** 31

/** One idempotency key per pay or decline the person starts; a retry of the same action sends the same key. */
export const MakeActionKey = Command.define('MakeActionKey', {
  args: { requestId: Schema.String, kind: RequestActionKind },
  messages: [Message.CompletedMakeActionKey],
  execute: ({ requestId, kind }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const salt = yield* Random.nextIntBetween(0, KEY_SPACE)
      return Message.CompletedMakeActionKey({
        requestId,
        kind,
        key: `card-${kind === 'Pay' ? 'pay' : 'decline'}-${requestId}-${now.toString(36)}-${salt.toString(36)}`,
      })
    }),
})

export const SendRequestAction = Command.define('SendRequestAction', {
  args: { requestId: Schema.String, kind: RequestActionKind, key: Schema.String },
  messages: [Message.SucceededRequestAction, Message.FailedRequestAction],
  execute: ({ requestId, kind, key }) =>
    Effect.gen(function* () {
      const host = yield* Host
      const reply = yield* host.callTool(kind === 'Pay' ? 'request_pay' : 'request_decline', {
        request_id: requestId,
        idempotency_key: key,
      })
      return Message.SucceededRequestAction({ kind, reply })
    }).pipe(Effect.catch(error => Effect.succeed(Message.FailedRequestAction({ reason: error.reason })))),
})

// POLLING

/** What the card is waiting on, if anything: a payment that has not settled, or the Home wallet. */
type PollTarget = { readonly _tag: 'Payment'; readonly paymentId: string } | { readonly _tag: 'Wallet' }

const unsettled = (payment: PaymentView): Option.Option<PollTarget> =>
  isSettled(payment) ? Option.none() : Option.some({ _tag: 'Payment', paymentId: payment.payment_id })

const shownTarget = (shown: Shown): Option.Option<PollTarget> =>
  Shown.match<Option.Option<PollTarget>>(shown, {
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
    Request: () => Option.none(),
    Requests: () => Option.none(),
  })

export const pollTargetOf = (model: Model): Option.Option<PollTarget> =>
  Option.match(Option.flatMap(model.maybeActivePayment, unsettled), {
    onSome: Option.some,
    onNone: () => (model.surface === 'Home' ? Option.some({ _tag: 'Wallet' }) : shownTarget(model.shown)),
  })

/** Whether the payment the card watches had already settled before this poll (so the AI already knows). */
const wasSettled = (model: Model): boolean =>
  Option.match(model.maybeActivePayment, {
    onSome: isSettled,
    onNone: () => Option.isNone(shownTarget(model.shown)),
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
      commands:
        target._tag === 'Payment' ? [PollPayment({ paymentId: target.paymentId })] : [PollWallet(), PollInbox()],
    }),
  })
}

const withPayment = (model: Model, payment: PaymentView): Model =>
  Option.isSome(model.maybeActivePayment)
    ? modifyFields(model, { maybeActivePayment: () => Option.some(payment) })
    : modifyFields(model, {
        shown: shown =>
          Shown.match<Shown>(shown, {
            Waiting: () => Shown.Payment({ payment }),
            ToolFailed: () => shown,
            Unrecognised: () => shown,
            Payment: () => Shown.Payment({ payment }),
            Purchase: ({ purchase }) => Shown.Purchase({ purchase, maybePayment: Option.some(payment) }),
            Wallet: () => shown,
            AllowanceLink: () => shown,
            Revoked: () => shown,
            Request: () => shown,
            Requests: () => shown,
          }),
      })

const replaceRequest = (requests: ReadonlyArray<RequestView>, request: RequestView) =>
  Array.map(requests, candidate => (candidate.request_id === request.request_id ? request : candidate))

/** A request the card changed (declined), wherever the card shows it. */
const withRequest = (model: Model, request: RequestView): Model =>
  modifyFields(model, {
    shown: shown =>
      Shown.match<Shown>(shown, {
        Waiting: () => shown,
        ToolFailed: () => shown,
        Unrecognised: () => shown,
        Payment: () => shown,
        Purchase: () => shown,
        Wallet: () => shown,
        AllowanceLink: () => shown,
        Revoked: () => shown,
        Request: () => Shown.Request({ request }),
        Requests: ({ requests }) => Shown.Requests({ requests: replaceRequest(requests, request) }),
      }),
    inbox: inbox => replaceRequest(inbox, request),
  })

/** Tell the AI once when a payment the card was watching settles; the same sentence is never sent twice. */
const shareSettled = (model: Model, settledBefore: boolean, payment: PaymentView): UpdateReturn => {
  const text = settledSentence(payment)
  const isNew = Option.match(model.maybeSharedContext, { onNone: () => true, onSome: shared => shared !== text })
  if (settledBefore || !isSettled(payment) || !isNew) {
    return { model }
  }
  return {
    model: modifyFields(model, { maybeSharedContext: () => Option.some(text) }),
    commands: [ShareContext({ text })],
  }
}

const afterPoll = (model: Model): Model =>
  modifyFields(model, { poll: () => Poll.Idle(), pollCount: count => count + 1 })

const unreadable = (reply: ToolReply): string => (reply.text === '' ? UNREADABLE : reply.text)

const pollFailed = (model: Model, reason: string): UpdateReturn => ({
  model: modifyFields(afterPoll(model), { maybePollError: () => Option.some(reason) }),
})

type ActionFields = Readonly<{ requestId: string; kind: RequestActionKind; key: string }>

/** The action a confirm (or a retry) sends: the one being confirmed, or the one that failed, with its own key. */
const actionToSend = (action: RequestAction): Option.Option<ActionFields> =>
  RequestAction.match<Option.Option<ActionFields>>(action, {
    Idle: () => Option.none(),
    Confirming: ({ requestId, kind, key }) => Option.some({ requestId, kind, key }),
    Sending: () => Option.none(),
    Failed: ({ requestId, kind, key }) => Option.some({ requestId, kind, key }),
  })

const failRequestAction = (model: Model, reason: string): UpdateReturn => ({
  model: modifyFields(model, {
    requestAction: action =>
      RequestAction.match<RequestAction>(action, {
        Idle: () => action,
        Confirming: () => action,
        Sending: ({ requestId, kind, key }) => RequestAction.Failed({ requestId, kind, key, reason }),
        Failed: () => action,
      }),
  }),
})

const requestActionSucceeded = (model: Model, kind: RequestActionKind, reply: ToolReply): UpdateReturn => {
  if (reply.isError) {
    return failRequestAction(model, unreadable(reply))
  }
  if (kind === 'Pay') {
    return Option.match(paymentOf(reply.structured), {
      onNone: () => failRequestAction(model, UNREADABLE),
      onSome: payment =>
        startPoll(
          modifyFields(model, {
            maybeActivePayment: () => Option.some(payment),
            requestAction: () => RequestAction.Idle(),
            pollCount: () => 0,
            maybePollError: () => Option.none(),
          }),
        ),
    })
  }
  return Option.match(requestOf(reply.structured), {
    onNone: () => failRequestAction(model, UNREADABLE),
    onSome: request => ({
      model: modifyFields(withRequest(model, request), { requestAction: () => RequestAction.Idle() }),
    }),
  })
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ConnectedToHost: ({ capabilities, context, hostInfo }) => {
      const connected = modifyFields(model, {
        bridge: () => Bridge.Connected({ capabilities: decodeCapabilities(capabilities) }),
        maybeAppName: () => appNameOf(hostInfo),
        appearance: appearance => mergeAppearance(appearance, context),
        maybeToolName: maybeToolName => Option.orElse(toolNameOf(context), () => maybeToolName),
      })
      return connected.surface === 'Home' ? startPoll(connected) : { model: connected }
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
        onNone: () => pollFailed(model, unreadable(reply)),
        onSome: payment =>
          shareSettled(
            modifyFields(withPayment(afterPoll(model), payment), { maybePollError: () => Option.none() }),
            wasSettled(model),
            payment,
          ),
      }),
    FailedPollPayment: ({ reason }) => pollFailed(model, reason),
    SucceededPollWallet: ({ reply }) =>
      Option.match(reply.isError ? Option.none() : walletOf(reply.structured), {
        onNone: () => pollFailed(model, unreadable(reply)),
        onSome: overview => ({
          model: modifyFields(afterPoll(model), {
            shown: () => Shown.Wallet({ overview }),
            maybePollError: () => Option.none(),
          }),
        }),
      }),
    FailedPollWallet: ({ reason }) => pollFailed(model, reason),
    SucceededPollInbox: ({ reply }) =>
      Option.match(reply.isError ? Option.none() : requestsOf(reply.structured), {
        onNone: () => ({ model }),
        onSome: requests => ({ model: modifyFields(model, { inbox: () => requests }) }),
      }),
    FailedPollInbox: () => ({ model }),
    ClickedOpenLink: ({ url }) => ({
      model: modifyFields(model, { link: () => LinkState.Opening({ url }) }),
      commands: [OpenLink({ url })],
    }),
    SucceededOpenLink: () => ({ model: modifyFields(model, { link: () => LinkState.Idle() }) }),
    FailedOpenLink: ({ url, reason }) => ({
      model: modifyFields(model, { link: () => LinkState.Failed({ url, reason }) }),
    }),
    CompletedShareContext: () => ({ model }),
    ClickedReviewRequest: ({ requestId }) => ({
      model: modifyFields(model, {
        maybeSelectedRequestId: () => Option.some(requestId),
        requestAction: () => RequestAction.Idle(),
      }),
    }),
    ClickedAllRequests: () => ({
      model: modifyFields(model, {
        maybeSelectedRequestId: () => Option.none(),
        requestAction: () => RequestAction.Idle(),
      }),
    }),
    ClickedRequestAction: ({ requestId, kind }) => ({ model, commands: [MakeActionKey({ requestId, kind })] }),
    CompletedMakeActionKey: ({ requestId, kind, key }) => ({
      model: modifyFields(model, { requestAction: () => RequestAction.Confirming({ requestId, kind, key }) }),
    }),
    ClickedConfirmRequestAction: () =>
      Option.match(actionToSend(model.requestAction), {
        onNone: () => ({ model }),
        onSome: fields => ({
          model: modifyFields(model, { requestAction: () => RequestAction.Sending(fields) }),
          commands: [SendRequestAction(fields)],
        }),
      }),
    ClickedCancelRequestAction: () => ({ model: modifyFields(model, { requestAction: () => RequestAction.Idle() }) }),
    SucceededRequestAction: ({ kind, reply }) => requestActionSucceeded(model, kind, reply),
    FailedRequestAction: ({ reason }) => failRequestAction(model, reason),
    ClickedClosePayment: () => ({
      model: modifyFields(model, {
        maybeActivePayment: () => Option.none(),
        maybeSelectedRequestId: () => Option.none(),
      }),
    }),
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
