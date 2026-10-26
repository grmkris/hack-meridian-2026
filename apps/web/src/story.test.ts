import { Option } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { fixture } from './backend/fixture'
import {
  CheckSession,
  LoadExternal,
  Message,
  type Model,
  NavigateInternal,
  ReplaceInternal,
  Session,
  SignOut,
  init,
  update,
} from './main'
import { Connections, Home, Receive, Welcome } from './page'
import { overview } from './page/fixtures'
import { Problem } from './problem'
import { AppRoute, urlToAppRoute } from './route'

const urlAt = (pathname: string): Url => ({
  protocol: 'https:',
  host: 'wallet.test',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

const checking = (pathname: string): Model => init(urlAt(pathname)).model

describe('session', () => {
  test('a live session opens the wallet and loads the page in the URL', () => {
    story(
      update,
      given(checking('/connections')),
      message(Message.SucceededCheckSession({ wallet: fixture.wallet })),
      model(nextModel => {
        expect(nextModel.session).toEqual(Session.SignedIn({ wallet: fixture.wallet }))
        expect(nextModel.route).toEqual(AppRoute.Connections())
      }),
      Command.expectExact(Home.LoadOverview, Connections.LoadConnections, Connections.LoadLinks),
      Command.resolve(
        Connections.LoadConnections,
        Connections.Message.SucceededLoadConnections({ connections: fixture.grants }),
      ),
      Command.resolve(Connections.LoadLinks, Connections.Message.SucceededLoadLinks({ links: [] })),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
    )
  })

  test('no session shows the passkey welcome, keeping the URL for after sign-in', () => {
    story(
      update,
      given(checking('/receipts')),
      message(Message.FailedCheckSession({ problem: Problem.SignedOut() })),
      model(nextModel => {
        expect(Session.guards.SignedOut(nextModel.session)).toBe(true)
        expect(nextModel.route).toEqual(AppRoute.Receipts())
      }),
    )
  })

  test('a 401 on any page drops back to the welcome page', () => {
    story(
      update,
      given(checking('/')),
      message(Message.SucceededCheckSession({ wallet: fixture.wallet })),
      Command.resolve(Home.LoadOverview, Home.Message.FailedLoadOverview({ problem: Problem.SignedOut() })),
      model(nextModel => {
        expect(nextModel.session).toEqual(
          Session.SignedOut({ welcome: Welcome.init(Option.none(), 'https://wallet.test/mcp').model }),
        )
      }),
    )
  })

  test('signing out ends the session whatever the Worker answers', () => {
    story(
      update,
      given(checking('/')),
      message(Message.SucceededCheckSession({ wallet: fixture.wallet })),
      Command.resolve(
        Home.LoadOverview,
        Home.Message.FailedLoadOverview({ problem: Problem.Failed({ error: 'Soroban RPC is down.' }) }),
      ),
      message(Message.ClickedSignOut()),
      Command.resolve(SignOut, Message.CompletedSignOut()),
      model(nextModel => {
        expect(Session.guards.SignedOut(nextModel.session)).toBe(true)
      }),
    )
  })

  test('the first render checks the session', () => {
    story(update, given(checking('/')), Command.expectNone())
    expect(init(urlAt('/')).commands).toEqual([CheckSession()])
  })
})

describe('links', () => {
  test('a legacy funding URL survives sign-in and becomes the dedicated Receive URL', () => {
    const url = { ...urlAt('/'), hash: Option.some('add-money') }
    story(
      update,
      given(init(url).model),
      message(Message.FailedCheckSession({ problem: Problem.SignedOut() })),
      message(Message.SucceededCheckSession({ wallet: fixture.wallet })),
      model(nextModel => {
        expect(nextModel.route).toEqual(AppRoute.Receive())
      }),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
      Command.expectExact(ReplaceInternal({ url: '/receive' })),
      Command.resolve(ReplaceInternal, Message.CompletedNavigateInternal()),
      message(Message.ToggledWalletDetails({ isOpen: true })),
      message(Message.GotHomeMessage({ message: Home.Message.ToggledSetup({ isOpen: true }) })),
      message(Message.TickedLiveRefresh()),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929601000 })),
      Command.expectNone(),
      model(nextModel => {
        expect(nextModel.route).toEqual(AppRoute.Receive())
        expect(nextModel.home.setupOpen).toBe(true)
        expect(nextModel.detailsOpen).toBe(true)
      }),
    )
  })

  test('Receive remembers the previous page and closes Wallet details', () => {
    const signedIn = modifyFields(checking('/contacts'), {
      session: () => Session.SignedIn({ wallet: fixture.wallet }),
      detailsOpen: () => true,
    })
    story(
      update,
      given(signedIn),
      message(Message.ChangedUrl({ url: { ...urlAt('/'), hash: Option.some('add-money') } })),
      model(nextModel => {
        expect(nextModel.route).toEqual(AppRoute.Receive())
        expect(nextModel.detailsOpen).toBe(false)
        expect(nextModel.route).toEqual(AppRoute.Receive())
      }),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
      Command.resolve(ReplaceInternal, Message.CompletedNavigateInternal()),
      model(next => {
        expect(next.receiveBackHref).toBe('/contacts')
      }),
    )
  })

  test('an approval link leaves the app for the Worker page', () => {
    story(
      update,
      given(checking('/')),
      message(Message.ClickedLink({ request: UrlRequest.Internal({ url: urlAt('/approve/int_dinner') }) })),
      Command.expectExact(LoadExternal({ href: 'https://wallet.test/approve/int_dinner' })),
      Command.resolve(LoadExternal, Message.CompletedLoadExternal()),
    )
  })

  test('a site link navigates inside the app', () => {
    story(
      update,
      given(checking('/')),
      message(Message.ClickedLink({ request: UrlRequest.Internal({ url: urlAt('/contacts') }) })),
      Command.expectExact(NavigateInternal({ url: 'https://wallet.test/contacts' })),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    )
  })
})

describe('live refresh', () => {
  test('a tick on Home revalidates the overview without dropping what is shown', () => {
    story(
      update,
      given(checking('/')),
      message(Message.SucceededCheckSession({ wallet: fixture.wallet })),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
      message(Message.TickedLiveRefresh()),
      model(nextModel => {
        expect(nextModel.home.overview).toEqual({ _tag: 'Refreshing', data: overview })
      }),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
    )
  })

  test('a tick while signed out does nothing', () => {
    story(
      update,
      given(checking('/')),
      message(Message.FailedCheckSession({ problem: Problem.SignedOut() })),
      message(Message.TickedLiveRefresh()),
      Command.expectNone(),
    )
  })
})

describe('Receive state across navigation', () => {
  test('leaving and returning preserves the draft and legacy receipts still opens Transactions', () => {
    const receive = modifyFields(Receive.init().model, {
      topupForm: () => ({ chain: 'base', assetId: 'usdc', amount: '7.25', refundTo: '0xrefund' }),
      network: () => 'base',
    })
    story(
      update,
      given(
        modifyFields(checking('/receive'), {
          session: () => Session.SignedIn({ wallet: fixture.wallet }),
          receive: () => receive,
        }),
      ),
      message(Message.ChangedUrl({ url: urlAt('/') })),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
      message(Message.ChangedUrl({ url: urlAt('/receive') })),
      Command.resolve(Home.LoadOverview, Home.Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
      model(next => {
        expect(next.receive.topupForm.amount).toBe('7.25')
        expect(next.receive.network).toBe('base')
      }),
    )
    expect(urlToAppRoute(urlAt('/receipts'))).toEqual(AppRoute.Receipts())
    expect(urlToAppRoute(urlAt('/transactions'))).toEqual(AppRoute.Receipts())
  })
})
