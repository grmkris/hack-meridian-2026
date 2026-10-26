import { Option } from 'effect'
import { Mount, expect, given, role, scene, text } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { type Model, Session, update, view } from './main'
import { Home, Receive, Welcome } from './page'
import { fixture, overview } from './page/fixtures'
import { AppRoute } from './route'

const signedIn: Model = {
  origin: 'https://wallet.test',
  route: AppRoute.Home(),
  fundingRequested: false,
  receiveBackHref: '/',
  receive: Receive.init().model,
  detailsOpen: false,
  maybeNowMs: Option.some(1792929600000),
  session: Session.SignedIn({ wallet: fixture.wallet }),
  home: modifyFields(Home.init().model, {
    overview: () => Home.OverviewData.Success({ data: overview }),
    maybeNowMs: () => Option.some(1792929600000),
  }),
  connections: {
    connections: { _tag: 'Idle' },
    links: { _tag: 'Idle' },
    revoke: { _tag: 'Idle' },
    maybeRuleRemovalUrl: Option.none(),
  },
  contacts: { contacts: { _tag: 'Idle' }, name: '', address: '', submission: { _tag: 'Idle' } },
  receipts: { receipts: { _tag: 'Idle' } },
}

describe('signed in', () => {
  test('home shows the wallet balance and the allowance as two separate numbers', () => {
    scene(
      { update, view },
      given(signedIn),
      expect(text('27.90 USDC')).toExist(),
      expect(text('Claude')).toExist(),
      expect(text('2.90 USDC')).toExist(),
      expect(text(/of 5.00 USDC/u)).toExist(),
      expect(role('link', { name: 'Receive' })).toHaveAttr('href', '/receive'),
      expect(role('link', { name: 'Transactions' })).toHaveAttr('href', '/transactions'),
      expect(role('link', { name: 'Wallet' })).toHaveAttr('aria-current', 'page'),
      expect(role('link', { name: 'Review and approve' })).toHaveAttr('href', '/approve/int_dinner'),
    )
  })
})

describe('signed out', () => {
  test('offers sign in and creation before any passkey prompt', () => {
    scene(
      { update, view },
      given(
        modifyFields(signedIn, {
          session: () => Session.SignedOut({ welcome: Welcome.init(Option.none(), 'https://wallet.test/mcp').model }),
        }),
      ),
      expect(role('button', { name: 'Sign in with passkey' })).toExist(),
      expect(role('button', { name: 'Create wallet' })).toExist(),
      expect(role('textbox', { name: 'Wallet name' })).not.toExist(),
      // The hero's night flight decides in the browser whether to play; here it settles without playing.
      Mount.resolve(Welcome.PlayNightFlight, Welcome.Message.SettledNightFlight({ playing: false })),
    )
  })
})
