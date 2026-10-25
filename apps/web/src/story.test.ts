import { Option } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { Command, given, message, model, story } from 'foldkit/story'
import type { Url } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { fixture } from './backend/fixture'
import {
  CheckSession,
  LoadExternal,
  Message,
  type Model,
  NavigateInternal,
  Session,
  SignOut,
  init,
  update,
} from './main'
import { Connections, Home, Welcome } from './page'
import { Problem } from './problem'
import { AppRoute } from './route'

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
      Command.expectExact(Connections.LoadConnections),
      Command.resolve(
        Connections.LoadConnections,
        Connections.Message.SucceededLoadConnections({ connections: fixture.grants }),
      ),
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
        expect(nextModel.session).toEqual(Session.SignedOut({ welcome: Welcome.init(Option.none()).model }))
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
