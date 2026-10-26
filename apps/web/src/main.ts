import { Array, Clock, Duration, Effect, Option, Schema, Stream } from 'effect'
import { AsyncData, Command, type Runtime, Subscription, Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest, load, pushUrl } from 'foldkit/navigation'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import { Disclosure } from '@foldkit/ui'

import { Backend, type GrantView, type Resources, WalletSummary } from './backend'
import { nextAllowanceExpiry } from './connection'
import { explorerAccountUrl, networkLabel, shortAddress } from './format'
import { Connections, Contacts, Home, Receipts, Welcome } from './page'
import { Problem, recoverProblem } from './problem'
import {
  AppRoute,
  connectionsRouter,
  contactsRouter,
  homeRouter,
  isWorkerPage,
  receiptsRouter,
  urlToAppRoute,
} from './route'
import { BUTTON_SECONDARY, LINK, emptyRow } from './view/ui'

// MODEL

export const Session = defineTaggedUnion({
  Checking: {},
  SignedOut: { welcome: Welcome.Model },
  SignedIn: { wallet: WalletSummary },
})
export type Session = typeof Session.Type

export const Model = Schema.Struct({
  origin: Schema.String,
  route: AppRoute,
  fundingRequested: Schema.Boolean,
  detailsOpen: Schema.Boolean,
  maybeNowMs: Schema.Option(Schema.Finite),
  session: Session,
  home: Home.Model,
  connections: Connections.Model,
  contacts: Contacts.Model,
  receipts: Receipts.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  SucceededCheckSession: { wallet: WalletSummary },
  FailedCheckSession: { problem: Problem },
  ClickedSignOut: {},
  ToggledWalletDetails: { isOpen: Schema.Boolean },
  CompletedSignOut: {},
  TickedLiveRefresh: {},
  TickedTopupClock: { nowMs: Schema.Finite },
  GotHomeMessage: { message: Home.Message },
  GotConnectionsMessage: { message: Connections.Message },
  GotContactsMessage: { message: Contacts.Message },
  GotReceiptsMessage: { message: Receipts.Message },
  GotWelcomeMessage: { message: Welcome.Message },
})
export type Message = typeof Message.Type

// COMMAND

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

export const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

export const CheckSession = Command.define('CheckSession', {
  messages: [Message.SucceededCheckSession, Message.FailedCheckSession],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const wallet = yield* backend.session
    return Message.SucceededCheckSession({ wallet })
  }).pipe(recoverProblem(problem => Message.FailedCheckSession({ problem }))),
})

export const SignOut = Command.define('SignOut', {
  messages: [Message.CompletedSignOut],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    yield* backend.signOut
  }).pipe(Effect.ignore, Effect.as(Message.CompletedSignOut())),
})

// INIT

const freshPages = (): Pick<Model, 'home' | 'connections' | 'contacts' | 'receipts'> => ({
  home: Home.init().model,
  connections: Connections.init().model,
  contacts: Contacts.init().model,
  receipts: Receipts.init().model,
})

const originOf = (url: Url): string =>
  `${url.protocol}//${url.host}${Option.match(url.port, { onNone: () => '', onSome: port => `:${port}` })}`

export const connectorUrlOf = (origin: string): string => `${origin}/mcp`

export const init: Runtime.RoutingApplicationInit<Model, Message, void, Resources> = url => ({
  model: {
    origin: originOf(url),
    route: urlToAppRoute(url),
    fundingRequested: Option.contains('add-money')(url.hash),
    detailsOpen: false,
    maybeNowMs: Option.none(),
    session: Session.Checking(),
    ...freshPages(),
  },
  commands: [CheckSession()],
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Resources>
type Step = Update.Step<Model, Message, Resources>

const keepModel: Step = model => ({ model })

const setRoute =
  (url: Url): Step =>
  model => ({
    model: modifyFields(model, {
      route: () => urlToAppRoute(url),
      fundingRequested: () => Option.contains('add-money')(url.hash),
      detailsOpen: () => false,
    }),
  })

const signOutLocally =
  (maybeError: Option.Option<string>): Step =>
  model => {
    const pages = freshPages()
    return {
      model: modifyFields(model, {
        session: (): Session =>
          Session.SignedOut({ welcome: Welcome.init(maybeError, connectorUrlOf(model.origin)).model }),
        detailsOpen: () => false,
        maybeNowMs: () => Option.none(),
        home: () => pages.home,
        connections: () => pages.connections,
        contacts: () => pages.contacts,
        receipts: () => pages.receipts,
      }),
    }
  }

const endSession = signOutLocally(Option.none())

const foldHomeOutMessage = Home.OutMessage.match<Step>({ EndedSession: () => endSession })
const foldConnectionsOutMessage = Connections.OutMessage.match<Step>({ EndedSession: () => endSession })
const foldContactsOutMessage = Contacts.OutMessage.match<Step>({ EndedSession: () => endSession })
const foldReceiptsOutMessage = Receipts.OutMessage.match<Step>({ EndedSession: () => endSession })

const homeSlot = {
  read: (model: Model) => Option.some(model.home),
  write: (model: Model, nextHome: Home.Model) => modifyFields(model, { home: () => nextHome }),
  toParentMessage: (message: Home.Message) => Message.GotHomeMessage({ message }),
  foldOutMessage: foldHomeOutMessage,
}
const connectionsSlot = {
  read: (model: Model) => Option.some(model.connections),
  write: (model: Model, nextConnections: Connections.Model) =>
    modifyFields(model, { connections: () => nextConnections }),
  toParentMessage: (message: Connections.Message) => Message.GotConnectionsMessage({ message }),
  foldOutMessage: foldConnectionsOutMessage,
}
const contactsSlot = {
  read: (model: Model) => Option.some(model.contacts),
  write: (model: Model, nextContacts: Contacts.Model) => modifyFields(model, { contacts: () => nextContacts }),
  toParentMessage: (message: Contacts.Message) => Message.GotContactsMessage({ message }),
  foldOutMessage: foldContactsOutMessage,
}
const receiptsSlot = {
  read: (model: Model) => Option.some(model.receipts),
  write: (model: Model, nextReceipts: Receipts.Model) => modifyFields(model, { receipts: () => nextReceipts }),
  toParentMessage: (message: Receipts.Message) => Message.GotReceiptsMessage({ message }),
  foldOutMessage: foldReceiptsOutMessage,
}

const foldHome = Update.foldChild({ update: Home.update, ...homeSlot })
const foldConnections = Update.foldChild({ update: Connections.update, ...connectionsSlot })
const foldContacts = Update.foldChild({ update: Contacts.update, ...contactsSlot })
const foldReceipts = Update.foldChild({ update: Receipts.update, ...receiptsSlot })

const openFunding = Update.foldChildStep({ update: Home.informFundingRequested, ...homeSlot })
const openRequestedFunding: Step = model =>
  model.fundingRequested && AppRoute.guards.Home(model.route) ? openFunding(model) : { model }

const enterHome = Update.foldChildStep({ update: Home.informEntered, ...homeSlot })
const enterConnections = Update.foldChildStep({ update: Connections.informEntered, ...connectionsSlot })
const enterContacts = Update.foldChildStep({ update: Contacts.informEntered, ...contactsSlot })
const enterReceipts = Update.foldChildStep({ update: Receipts.informEntered, ...receiptsSlot })

const enterRoute = (route: AppRoute): Step =>
  AppRoute.match<Step>(route, {
    Home: () => enterHome,
    Connections: () => enterConnections,
    Contacts: () => enterContacts,
    Receipts: () => enterReceipts,
    NotFound: () => keepModel,
  })

const enterCurrentRoute: Step = model => enterRoute(model.route)(model)

const whenSignedIn =
  (step: Step): Step =>
  model =>
    Session.guards.SignedIn(model.session) ? step(model) : { model }

const startSession =
  (wallet: WalletSummary): Step =>
  model =>
    Update.combine(model, [
      stepModel => ({ model: modifyFields(stepModel, { session: (): Session => Session.SignedIn({ wallet }) }) }),
      enterCurrentRoute,
      openRequestedFunding,
    ])

const foldWelcomeOutMessage = Welcome.OutMessage.match<Step>({
  StartedSession: ({ wallet }) => startSession(wallet),
})

const foldWelcome = Update.foldChild({
  update: Welcome.update,
  read: (model: Model) =>
    Session.matchOrElse(model.session, { SignedOut: ({ welcome }) => Option.some(welcome) }, () =>
      Option.none<Welcome.Model>(),
    ),
  write: (model: Model, nextWelcome: Welcome.Model): Model =>
    modifyFields(model, { session: (): Session => Session.SignedOut({ welcome: nextWelcome }) }),
  toParentMessage: (message: Welcome.Message) => Message.GotWelcomeMessage({ message }),
  foldOutMessage: foldWelcomeOutMessage,
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [
            isWorkerPage(url.pathname)
              ? LoadExternal({ href: urlToString(url) })
              : NavigateInternal({ url: urlToString(url) }),
          ],
        }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => {
      const nextRoute = urlToAppRoute(url)
      return Update.combine(model, [
        setRoute(url),
        whenSignedIn(enterRoute(nextRoute)),
        whenSignedIn(openRequestedFunding),
      ])
    },
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    SucceededCheckSession: ({ wallet }) => startSession(wallet)(model),
    FailedCheckSession: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => endSession(model),
        Failed: ({ error }) => signOutLocally(Option.some(error))(model),
      }),
    ToggledWalletDetails: ({ isOpen }) => ({ model: modifyFields(model, { detailsOpen: () => isOpen }) }),
    ClickedSignOut: () => ({ model: modifyFields(model, { detailsOpen: () => false }), commands: [SignOut()] }),
    CompletedSignOut: () => endSession(model),
    TickedLiveRefresh: () => whenSignedIn(enterRoute(model.route))(model),
    TickedTopupClock: ({ nowMs }) =>
      Update.combine(model, [
        stepModel => ({ model: modifyFields(stepModel, { maybeNowMs: () => Option.some(nowMs) }) }),
        Update.foldChildStep({ update: Home.informClock(nowMs), ...homeSlot }),
      ]),
    GotHomeMessage: ({ message: homeMessage }) => foldHome(model, homeMessage),
    GotConnectionsMessage: ({ message: connectionsMessage }) => foldConnections(model, connectionsMessage),
    GotContactsMessage: ({ message: contactsMessage }) => foldContacts(model, contactsMessage),
    GotReceiptsMessage: ({ message: receiptsMessage }) => foldReceipts(model, receiptsMessage),
    GotWelcomeMessage: ({ message: welcomeMessage }) => foldWelcome(model, welcomeMessage),
  })

// SUBSCRIPTION

const LIVE_REFRESH = Duration.seconds(8)

const isWatchingHome = (model: Model): boolean =>
  Session.guards.SignedIn(model.session) && AppRoute.isAnyOf(['Home'])(model.route)

/** Only the pending top-up countdown needs a repeating clock. */
const isCountingTopup = (model: Model): boolean => isWatchingHome(model) && Home.isTopupWaiting(model.home)

const allowanceClock = (model: Model) => {
  const grants = AppRoute.match<ReadonlyArray<GrantView>>(model.route, {
    Home: () =>
      AsyncData.matchData(model.home.overview, {
        onEmpty: () => [],
        onFailure: () => [],
        onData: overview => overview.grants,
      }),
    Connections: () =>
      AsyncData.matchData(model.connections.connections, {
        onEmpty: () => [],
        onFailure: () => [],
        onData: connections => connections,
      }),
    Contacts: () => [],
    Receipts: () => [],
    NotFound: () => [],
  })
  return {
    isWatching: Session.guards.SignedIn(model.session) && AppRoute.isAnyOf(['Home', 'Connections'])(model.route),
    needsNow: Option.isNone(model.maybeNowMs),
    until: nextAllowanceExpiry(
      grants,
      Option.getOrElse(model.maybeNowMs, () => 0),
    ),
  }
}

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  topupClock: entry(
    { isCounting: Schema.Boolean },
    {
      modelToDependencies: model => ({ isCounting: isCountingTopup(model) }),
      dependenciesToStream: ({ isCounting }) =>
        Stream.when(
          Stream.tick(Duration.seconds(1)).pipe(
            Stream.mapEffect(() => Clock.currentTimeMillis),
            Stream.map(nowMs => Message.TickedTopupClock({ nowMs })),
          ),
          Effect.sync(() => isCounting),
        ),
    },
  ),
  allowanceExpiry: entry(
    { isWatching: Schema.Boolean, needsNow: Schema.Boolean, until: Schema.Option(Schema.Finite) },
    {
      modelToDependencies: allowanceClock,
      dependenciesToStream: ({ isWatching, needsNow, until }) =>
        !isWatching || (!needsNow && Option.isNone(until))
          ? Stream.empty
          : Stream.fromEffect(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                if (!needsNow && Option.isSome(until))
                  yield* Effect.sleep(Duration.millis(Math.max(0, until.value - now)))
                const nowMs = yield* Clock.currentTimeMillis
                return Message.TickedTopupClock({ nowMs })
              }),
            ),
    },
  ),
  liveHome: entry(
    { isWatching: Schema.Boolean },
    {
      modelToDependencies: model => ({ isWatching: isWatchingHome(model) }),
      dependenciesToStream: ({ isWatching }) =>
        Stream.when(
          Stream.tick(LIVE_REFRESH).pipe(
            Stream.drop(1),
            Stream.map(() => Message.TickedLiveRefresh()),
          ),
          Effect.sync(() => isWatching),
        ),
    },
  ),
}))

// VIEW

const NAVIGATION: ReadonlyArray<
  Readonly<{ label: string; href: () => string; isActive: (route: AppRoute) => boolean }>
> = [
  { label: 'Home', href: homeRouter, isActive: AppRoute.isAnyOf(['Home']) },
  { label: 'Connections', href: connectionsRouter, isActive: AppRoute.isAnyOf(['Connections']) },
  { label: 'Contacts', href: contactsRouter, isActive: AppRoute.isAnyOf(['Contacts']) },
  { label: 'Receipts', href: receiptsRouter, isActive: AppRoute.isAnyOf(['Receipts']) },
]

const navigationView = (route: AppRoute, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [h.AriaLabel('Wallet')],
    [
      h.ul(
        [h.Class('flex flex-wrap items-center gap-x-5 gap-y-1')],
        Array.map(NAVIGATION, item =>
          h.keyed('li')(
            item.label,
            [],
            [
              h.a(
                [
                  h.Href(item.href()),
                  ...(item.isActive(route) ? [h.AriaCurrent('page')] : []),
                  h.Class(`${LINK} inline-flex min-h-11 items-center text-sm`),
                ],
                [item.label],
              ),
            ],
          ),
        ),
      ),
    ],
  )

const headerView = (wallet: WalletSummary, model: Model, h: HtmlBuilder<Message>): Html =>
  Disclosure.view(
    {
      id: 'wallet-details',
      isOpen: model.detailsOpen,
      onToggle: isOpen => Message.ToggledWalletDetails({ isOpen }),
      toView: attributes =>
        h.header(
          [h.Class('mx-auto max-w-[920px] px-6')],
          [
            h.div(
              [h.Class('flex min-h-24 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-4')],
              [
                h.div(
                  [h.Class('flex items-center gap-4')],
                  [
                    h.a(
                      [
                        h.Href(homeRouter()),
                        h.AriaLabel('Nod home'),
                        h.Class(
                          'inline-flex min-h-11 items-center rounded-lg font-display text-3xl font-bold tracking-[-0.025em] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent',
                        ),
                      ],
                      ['nod'],
                    ),
                    h.span([h.Class('text-xs text-muted')], [`Stellar ${networkLabel(wallet.network)}`]),
                  ],
                ),
                !AppRoute.guards.Home(model.route)
                  ? h.a([h.Href(`${homeRouter()}#add-money`), h.Class(`${BUTTON_SECONDARY} ml-auto`)], ['Top up'])
                  : h.empty,
                h.button(
                  [
                    ...attributes.button,
                    h.Class(
                      'inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent',
                    ),
                  ],
                  [
                    'Wallet details',
                    h.svg(
                      [
                        h.ViewBox('0 0 16 16'),
                        h.AriaHidden(true),
                        h.Class(`size-4 shrink-0 ${model.detailsOpen ? 'rotate-180' : ''}`),
                      ],
                      [h.path([h.D('m4 6 4 4 4-4'), h.Fill('none'), h.Stroke('currentColor'), h.StrokeWidth('1.5')])],
                    ),
                  ],
                ),
              ],
            ),
            model.detailsOpen
              ? h.div(
                  [...attributes.panel, h.Class('flex flex-col items-start gap-3 border-b border-line pb-5')],
                  [
                    navigationView(model.route, h),
                    h.a(
                      [
                        h.Href(explorerAccountUrl(wallet.network, wallet.contract_id)),
                        h.Target('_blank'),
                        h.Rel('noopener noreferrer'),
                        h.Title(wallet.contract_id),
                        h.DataAttribute('testid', 'wallet-explorer'),
                        h.Class(`${LINK} inline-flex min-h-11 items-center text-sm [overflow-wrap:anywhere]`),
                      ],
                      [`${wallet.name} (${shortAddress(wallet.contract_id)})`],
                    ),
                    h.button(
                      [h.Type('button'), h.OnClick(Message.ClickedSignOut()), h.Class(BUTTON_SECONDARY)],
                      ['Sign out'],
                    ),
                  ],
                )
              : h.empty,
          ],
        ),
    },
    h,
  )

const notFoundView = (path: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-4')],
    [emptyRow(`Nothing lives at ${path}.`, h), h.a([h.Href(homeRouter()), h.Class(LINK)], ['Back to your wallet'])],
  )

const routeView = (model: Model, wallet: WalletSummary, h: HtmlBuilder<Message>): Html =>
  AppRoute.match<Html>(model.route, {
    Home: () =>
      h.submodel({
        slotId: 'home',
        model: model.home,
        view: Home.view,
        viewInputs: { connectorUrl: connectorUrlOf(model.origin) },
        toParentMessage: message => Message.GotHomeMessage({ message }),
      }),
    Connections: () =>
      h.submodel({
        slotId: 'connections',
        model: model.connections,
        view: Connections.view,
        viewInputs: { network: wallet.network, nowMs: model.maybeNowMs },
        toParentMessage: message => Message.GotConnectionsMessage({ message }),
      }),
    Contacts: () =>
      h.submodel({
        slotId: 'contacts',
        model: model.contacts,
        view: Contacts.view,
        toParentMessage: message => Message.GotContactsMessage({ message }),
      }),
    Receipts: () =>
      h.submodel({
        slotId: 'receipts',
        model: model.receipts,
        view: Receipts.view,
        toParentMessage: message => Message.GotReceiptsMessage({ message }),
      }),
    NotFound: ({ path }) => notFoundView(path, h),
  })

const signedInView = (model: Model, wallet: WalletSummary, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('wallet-app min-h-dvh')],
    [
      headerView(wallet, model, h),
      h.main([h.Class('mx-auto max-w-[920px] px-6 pt-3 pb-12')], [routeView(model, wallet, h)]),
    ],
  )

const checkingView = (h: HtmlBuilder<Message>): Html =>
  h.main(
    [h.Class('flex min-h-dvh items-center justify-center')],
    [h.p([h.AriaLive('polite'), h.Class('text-sm text-muted')], ['Opening your wallet…'])],
  )

const routeTitle = (route: AppRoute): string =>
  AppRoute.match<string>(route, {
    Home: () => 'Home',
    Connections: () => 'Connections',
    Contacts: () => 'Contacts',
    Receipts: () => 'Receipts',
    NotFound: () => 'Not found',
  })

const pageTitle = (model: Model): string =>
  Session.match<string>(model.session, {
    Checking: () => 'Nod',
    SignedOut: () => 'Nod | Give your AI an allowance',
    SignedIn: () => `${routeTitle(model.route)} | Nod`,
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: pageTitle(model),
  body: Session.match<Html>(model.session, {
    Checking: () => checkingView(h),
    SignedOut: ({ welcome }) =>
      h.submodel({
        slotId: 'welcome',
        model: welcome,
        view: Welcome.view,
        toParentMessage: message => Message.GotWelcomeMessage({ message }),
      }),
    SignedIn: ({ wallet }) => signedInView(model, wallet, h),
  }),
})
