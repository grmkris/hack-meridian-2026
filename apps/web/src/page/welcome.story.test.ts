import { Option } from 'effect'
import { Command, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { Problem } from '../problem'
import { fixture } from './fixtures'
import { Ceremony, Copy, CopyConnectorUrl, CreateWallet, Message, OutMessage, SignIn, init, update } from './welcome'

const CONNECTOR = 'https://wallet.test/mcp'

describe('Welcome', () => {
  test('creating a wallet runs one passkey ceremony and starts the session', () => {
    story(
      update,
      given(init(Option.none(), CONNECTOR).model),
      message(Message.UpdatedWalletName({ value: '  Travel ' })),
      message(Message.SubmittedCreateWallet()),
      Command.expectExact(CreateWallet({ name: 'Travel' })),
      Command.resolve(CreateWallet, Message.SucceededCreateWallet({ wallet: fixture.wallet })),
      expectOutMessage(OutMessage.StartedSession({ wallet: fixture.wallet })),
    )
  })

  test('while a passkey prompt is open, neither button starts another', () => {
    story(
      update,
      given(modifyFields(init(Option.none(), CONNECTOR).model, { ceremony: () => Ceremony.CreatingWallet() })),
      message(Message.SubmittedCreateWallet()),
      message(Message.ClickedSignIn()),
      Command.expectNone(),
    )
  })

  test('an empty name falls back to Personal', () => {
    story(
      update,
      given(init(Option.none(), CONNECTOR).model),
      message(Message.UpdatedWalletName({ value: '   ' })),
      message(Message.SubmittedCreateWallet()),
      Command.expectExact(CreateWallet({ name: 'Personal' })),
      Command.resolve(CreateWallet, Message.FailedCreateWallet({ problem: Problem.Failed({ error: 'Dismissed.' }) })),
      model(nextModel => {
        expect(nextModel.ceremony).toEqual(Ceremony.Failed({ error: 'Dismissed.' }))
      }),
    )
  })

  test('Add to Claude copies the connector URL', () => {
    story(
      update,
      given(init(Option.none(), CONNECTOR).model),
      message(Message.ClickedAddToClaude()),
      Command.expectExact(CopyConnectorUrl({ url: CONNECTOR })),
      Command.resolve(CopyConnectorUrl, Message.CompletedCopyConnectorUrl()),
      model(nextModel => {
        expect(nextModel.copy).toEqual(Copy.Copied())
      }),
    )
  })

  test('signing in with a passkey starts the session', () => {
    story(
      update,
      given(init(Option.none(), CONNECTOR).model),
      message(Message.ClickedSignIn()),
      Command.expectExact(SignIn),
      Command.resolve(SignIn, Message.SucceededSignIn({ wallet: fixture.wallet })),
      expectOutMessage(OutMessage.StartedSession({ wallet: fixture.wallet })),
    )
  })
})
