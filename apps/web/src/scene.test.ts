import { Option } from 'effect'
import { Mount, expect, given, role, scene, text } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { type Model, Session, update, view } from './main'
import { Home, Welcome } from './page'
import { fixture, overview } from './page/fixtures'
import { AppRoute } from './route'

const signedIn: Model = {
  origin: 'https://wallet.test',
  route: AppRoute.Home(),
  session: Session.SignedIn({ wallet: fixture.wallet }),
  home: modifyFields(Home.init().model, { overview: () => Home.OverviewData.Success({ data: overview }) }),
  connections: { connections: { _tag: 'Idle' }, revoke: { _tag: 'Idle' }, maybeRuleRemovalUrl: Option.none() },
  contacts: { contacts: { _tag: 'Idle' }, name: '', address: '', submission: { _tag: 'Idle' } },
  receipts: { receipts: { _tag: 'Idle' } },
}

describe('signed in', () => {
  test('home shows the wallet balance and the allowance as two separate numbers', () => {
    scene(
      { update, view },
      given(signedIn),
      expect(text('27.90 USDC')).toExist(),
      expect(text('2.90 USDC left')).toExist(),
      expect(role('link', { name: 'Home' })).toHaveAttr('aria-current', 'page'),
      expect(role('link', { name: 'Review' })).toHaveAttr('href', '/approve/int_dinner'),
    )
  })
})

describe('signed out', () => {
  test('offers to create a passkey wallet or sign in', () => {
    scene(
      { update, view },
      given(
        modifyFields(signedIn, {
          session: () => Session.SignedOut({ welcome: Welcome.init(Option.none(), 'https://wallet.test/mcp').model }),
        }),
      ),
      expect(role('button', { name: 'Create your wallet' })).toExist(),
      expect(role('button', { name: 'Sign in with your passkey' })).toExist(),
      // The hero's night flight decides in the browser whether to play; here it settles without playing.
      Mount.resolve(Welcome.PlayNightFlight, Welcome.Message.SettledNightFlight({ playing: false })),
    )
  })
})
