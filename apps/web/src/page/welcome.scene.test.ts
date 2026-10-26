import { Option } from 'effect'
import { Command, Mount, click, expect, given, role, scene, text, type } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Problem } from '../problem'
import {
  CreateWallet,
  FocusConnectWallet,
  FocusWalletName,
  Message,
  PlayNightFlight,
  SignIn,
  init,
  update,
  view,
} from './welcome'

const initial = init(Option.none(), 'https://trynod.si/mcp').model
const settled = Mount.resolve(PlayNightFlight, Message.SettledNightFlight({ playing: false }))

describe('connecting a wallet', () => {
  test('a cancelled prompt offers a new wallet only after the visitor explicitly chooses it', () => {
    scene(
      { update, view },
      given(initial),
      settled,
      expect(role('button', { name: 'Sign in with passkey' })).toExist(),
      expect(role('button', { name: 'Create wallet' })).toExist(),
      expect(role('textbox', { name: 'Wallet name' })).not.toExist(),
      click(role('button', { name: 'Sign in with passkey' })),
      expect(role('button', { name: 'Signing in…' })).toBeDisabled(),
      expect(role('button', { name: 'Create wallet' })).toBeDisabled(),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({
          problem: Problem.Failed({ error: 'The passkey step did not finish. Try again.' }),
        }),
      ),
      Command.resolve(FocusConnectWallet, Message.CompletedFocusConnectWallet()),
      expect(role('button', { name: 'Sign in with passkey' })).toExist(),
      expect(role('button', { name: 'Create wallet' })).toExist(),
      expect(role('textbox', { name: 'Wallet name' })).not.toExist(),
      Command.expectNone(),
      click(role('button', { name: 'Create wallet' })),
      Command.resolve(FocusWalletName, Message.CompletedFocusWalletName()),
      expect(role('textbox', { name: 'Wallet name' })).toExist(),
      Command.expectNone(),
      type(role('textbox', { name: 'Wallet name' }), 'Travel'),
      click(role('button', { name: 'Continue with a passkey' })),
      Command.resolve(
        CreateWallet,
        Message.FailedCreateWallet({ problem: Problem.Failed({ error: 'Nod did not answer. Try again.' }) }),
      ),
      expect(role('alert')).toHaveText('Nod did not answer. Try again.'),
      expect(role('textbox', { name: 'Wallet name' })).toHaveValue('Travel'),
      expect(role('button', { name: 'Continue with a passkey' })).toExist(),
    )
  })

  test('unsupported browsers explain why both passkey actions are unavailable', () => {
    scene(
      { update, view },
      given(initial),
      settled,
      click(role('button', { name: 'Sign in with passkey' })),
      Command.resolve(SignIn, Message.UnavailablePasskey()),
      expect(
        text('This browser cannot use passkeys. Open Nod in Safari, Chrome, or another browser that supports them.'),
      ).toExist(),
      expect(role('button', { name: 'Create wallet' })).toBeDisabled(),
      expect(role('button', { name: 'Sign in with passkey' })).toBeDisabled(),
      Command.expectNone(),
    )
  })
})
