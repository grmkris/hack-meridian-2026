import { Option } from 'effect'
import {
  Command,
  Mount,
  click,
  type as typeInto,
  submit,
  expect,
  given,
  role,
  scene,
  testId,
  text,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { type Model, Session, FocusWalletName, Message, RenameWallet, SwitchWallet, update, view } from './main'
import { Home, Receive, Welcome } from './page'
import { fixture, overview } from './page/fixtures'
import { Problem } from './problem'
import { AppRoute } from './route'

const signedIn: Model = {
  origin: 'https://wallet.test',
  route: AppRoute.Home(),
  fundingRequested: false,
  receiveBackHref: '/',
  receive: Receive.init().model,
  detailsOpen: false,
  walletAction: { _tag: 'Idle' },
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

describe('wallet identity', () => {
  test('rename retains the address, rejects blank names, and recovers from a failed save', () => {
    scene(
      { update, view },
      given(signedIn),
      click(role('button', { name: 'Wallet details' })),
      click(role('button', { name: 'Rename' })),
      Command.resolve(FocusWalletName, Message.CompletedFocusWalletName()),
      typeInto(role('textbox', { name: 'Wallet name' }), '   '),
      expect(role('button', { name: 'Save name' })).toBeDisabled(),
      typeInto(role('textbox', { name: 'Wallet name' }), '  Travel  '),
      submit('form'),
      Command.expectExact(RenameWallet({ name: 'Travel' })),
      Command.resolve(RenameWallet, Message.FailedRenameWallet({ problem: Problem.Failed({ error: 'Try again.' }) })),
      expect(role('alert')).toHaveText('Try again.'),
      submit('form'),
      Command.resolve(RenameWallet, Message.SucceededRenameWallet({ wallet: { ...fixture.wallet, name: 'Travel' } })),
      expect(testId('wallet-explorer')).toHaveAttr('title', fixture.wallet.contract_id),
      expect(text('Travel')).toExist(),
      expect(role('textbox', { name: 'Wallet name' })).not.toExist(),
    )
  })

  test('switching fails visibly if sign-out fails, then cancellation leaves a usable sign-in', () => {
    scene(
      { update, view },
      given(signedIn),
      click(role('button', { name: 'Wallet details' })),
      click(role('button', { name: 'Switch wallet' })),
      Command.resolve(
        SwitchWallet,
        Message.FailedSignOut({ problem: Problem.Failed({ error: 'Nod did not answer.' }) }),
      ),
      expect(role('alert')).toHaveText('Nod did not answer.'),
      click(role('button', { name: 'Switch wallet' })),
      Command.resolve(SwitchWallet, Message.CompletedSwitchWallet()),
      Command.resolve(
        Welcome.SignIn,
        Welcome.Message.FailedSignIn({ problem: Problem.Failed({ error: 'No passkey selected.' }) }),
      ),
      Command.resolve(Welcome.FocusConnectWallet, Welcome.Message.CompletedFocusConnectWallet()),
      Mount.resolve(Welcome.PlayHeroFilm, Welcome.Message.SettledHeroFilm({ playing: false })),
      expect(role('alert')).toHaveText('No passkey selected.'),
      expect(testId('sign-in')).toExist(),
      expect(testId('wallet-balance')).not.toExist(),
    )
  })
})

describe('signed out', () => {
  test('offers a passkey entry before showing wallet fields', () => {
    scene(
      { update, view },
      given(
        modifyFields(signedIn, {
          session: () => Session.SignedOut({ welcome: Welcome.init(Option.none(), 'https://wallet.test/mcp').model }),
        }),
      ),
      expect(testId('sign-in')).toExist(),
      expect(role('textbox', { name: 'Wallet name' })).not.toExist(),
      // The hero's approval illustration decides in the browser whether to play; here it settles without playing.
      Mount.resolve(Welcome.PlayHeroFilm, Welcome.Message.SettledHeroFilm({ playing: false })),
    )
  })
})
