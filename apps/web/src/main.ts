import { Array, Duration, Effect, Option, Schema, Stream } from 'effect'
import { Command, type Runtime, Subscription, Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest, load, pushUrl } from 'foldkit/navigation'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import { Backend, type Resources, WalletSummary } from './backend'
import { explorerAccountUrl, isMainnet, networkLabel, shortAddress } from './format'
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
import { LINK, emptyRow } from './view/ui'

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
  CompletedSignOut: {},
  TickedLiveRefresh: {},
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
  model: { origin: originOf(url), route: urlToAppRoute(url), session: Session.Checking(), ...freshPages() },
  commands: [CheckSession()],
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Resources>
type Step = Update.Step<Model, Message, Resources>

const keepModel: Step = model => ({ model })

const setRoute =
  (nextRoute: AppRoute): Step =>
  model => ({ model: modifyFields(model, { route: () => nextRoute }) })

const signOutLocally =
  (maybeError: Option.Option<string>): Step =>
  model => {
    const pages = freshPages()
    return {
      model: modifyFields(model, {
        session: (): Session =>
          Session.SignedOut({ welcome: Welcome.init(maybeError, connectorUrlOf(model.origin)).model }),
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
      return Update.combine(model, [setRoute(nextRoute), whenSignedIn(enterRoute(nextRoute))])
    },
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    SucceededCheckSession: ({ wallet }) => startSession(wallet)(model),
    FailedCheckSession: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => endSession(model),
        Failed: ({ error }) => signOutLocally(Option.some(error))(model),
      }),
    ClickedSignOut: () => ({ model, commands: [SignOut()] }),
    CompletedSignOut: () => endSession(model),
    TickedLiveRefresh: () => whenSignedIn(enterRoute(model.route))(model),
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

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
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
    [h.AriaLabel('Wallet'), h.Class('-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0')],
    [
      h.ul(
        [h.Class('flex gap-1')],
        Array.map(NAVIGATION, item =>
          h.keyed('li')(
            item.label,
            [],
            [
              h.a(
                [
                  h.Href(item.href()),
                  ...(item.isActive(route) ? [h.AriaCurrent('page')] : []),
                  h.Class(
                    `inline-flex min-h-11 touch-manipulation items-center whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-starlight sm:px-4 ${
                      item.isActive(route)
                        ? 'bg-starlight text-night'
                        : 'text-starlight-muted hover:bg-night-raised hover:text-starlight'
                    }`,
                  ),
                ],
                [item.label],
              ),
            ],
          ),
        ),
      ),
    ],
  )

const networkBadge = (network: string, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(
        `whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold leading-none ring-1 ring-inset ${isMainnet(network) ? 'text-starlight ring-starlight-muted/60' : 'text-starlight-muted ring-night-line'}`,
      ),
    ],
    [`Stellar ${networkLabel(network)}`],
  )

const headerView = (wallet: WalletSummary, route: AppRoute, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('bg-night text-starlight')],
    [
      h.div(
        [h.Class('mx-auto flex max-w-5xl flex-col gap-3 px-4 pt-3 pb-3')],
        [
          h.div(
            [h.Class('flex items-center justify-between gap-3')],
            [
              h.div(
                [h.Class('flex min-w-0 items-center gap-3')],
                [
                  h.a(
                    [
                      h.Href(homeRouter()),
                      h.Class(
                        'rounded-md font-display text-[1.75rem] font-bold leading-none tracking-[-0.015em] text-starlight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-starlight',
                      ),
                    ],
                    ['nod'],
                  ),
                  networkBadge(wallet.network, h),
                ],
              ),
              h.div(
                [h.Class('flex items-center gap-3')],
                [
                  h.a(
                    [
                      h.Href(explorerAccountUrl(wallet.network, wallet.contract_id)),
                      h.Target('_blank'),
                      h.Rel('noreferrer'),
                      h.Title(wallet.contract_id),
                      h.Class(
                        'hidden text-sm text-starlight-muted underline decoration-starlight-muted/40 underline-offset-4 hover:text-starlight sm:inline',
                      ),
                    ],
                    [`${wallet.name} · ${shortAddress(wallet.contract_id)}`],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(Message.ClickedSignOut()),
                      h.Class(
                        'inline-flex min-h-11 touch-manipulation select-none items-center whitespace-nowrap rounded-full px-4 text-sm font-semibold text-starlight ring-1 ring-inset ring-night-line transition-colors hover:bg-night-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-starlight active:bg-night-raised',
                      ),
                    ],
                    ['Sign out'],
                  ),
                ],
              ),
            ],
          ),
          navigationView(route, h),
        ],
      ),
    ],
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
        toParentMessage: message => Message.GotHomeMessage({ message }),
      }),
    Connections: () =>
      h.submodel({
        slotId: 'connections',
        model: model.connections,
        view: Connections.view,
        viewInputs: { network: wallet.network },
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
    [h.Class('min-h-dvh')],
    [
      headerView(wallet, model.route, h),
      h.main([h.Class('mx-auto max-w-5xl px-4 py-6 sm:py-8')], [routeView(model, wallet, h)]),
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
