import { Array, Effect, Option, Schema, String } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, Passkey, type Resources, WalletSummary } from '../backend'
import { Problem, recoverProblem } from '../problem'
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT, errorRow } from '../view/ui'

// MODEL

export const Ceremony = defineTaggedUnion({
  Idle: {},
  CreatingWallet: {},
  SigningIn: {},
  Failed: { error: Schema.String },
})
export type Ceremony = typeof Ceremony.Type

export const Model = Schema.Struct({ walletName: Schema.String, ceremony: Ceremony })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedWalletName: { value: Schema.String },
  SubmittedCreateWallet: {},
  ClickedSignIn: {},
  SucceededCreateWallet: { wallet: WalletSummary },
  FailedCreateWallet: { problem: Problem },
  SucceededSignIn: { wallet: WalletSummary },
  FailedSignIn: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ StartedSession: { wallet: WalletSummary } })
export type OutMessage = typeof OutMessage.Type

// INIT

const DEFAULT_WALLET_NAME = 'Personal'

export const init = (maybeError: Option.Option<string>): Update.Return<Model, Message, Resources> => ({
  model: {
    walletName: DEFAULT_WALLET_NAME,
    ceremony: Option.match(maybeError, {
      onNone: () => Ceremony.Idle(),
      onSome: error => Ceremony.Failed({ error }),
    }),
  },
})

// COMMAND

const problemMessage = (problem: Problem): string =>
  Problem.match(problem, {
    SignedOut: () => 'Nod did not accept that passkey. Try again.',
    Failed: ({ error }) => error,
  })

export const CreateWallet = Command.define('CreateWallet', {
  args: { name: Schema.String },
  messages: [Message.SucceededCreateWallet, Message.FailedCreateWallet],
  execute: ({ name }) =>
    Effect.gen(function* () {
      const backend = yield* Backend
      const passkey = yield* Passkey
      const options = yield* backend.registrationOptions(name)
      const created = yield* passkey.create(options)
      const wallet = yield* backend.createWallet({ name, ...created })
      return Message.SucceededCreateWallet({ wallet })
    }).pipe(recoverProblem(problem => Message.FailedCreateWallet({ problem }))),
})

export const SignIn = Command.define('SignIn', {
  messages: [Message.SucceededSignIn, Message.FailedSignIn],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const passkey = yield* Passkey
    const options = yield* backend.assertionOptions
    const assertion = yield* passkey.assert(options)
    const wallet = yield* backend.signIn(assertion)
    return Message.SucceededSignIn({ wallet })
  }).pipe(recoverProblem(problem => Message.FailedSignIn({ problem }))),
})

// UPDATE

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const isBusy = (ceremony: Ceremony): boolean =>
  Ceremony.match<boolean>(ceremony, {
    Idle: () => false,
    CreatingWallet: () => true,
    SigningIn: () => true,
    Failed: () => false,
  })

const walletNameOf = (model: Model): string => {
  const trimmed = String.trim(model.walletName)
  return String.isEmpty(trimmed) ? DEFAULT_WALLET_NAME : trimmed
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedWalletName: ({ value }) => ({ model: modifyFields(model, { walletName: () => value }) }),
    SubmittedCreateWallet: () => {
      if (isBusy(model.ceremony)) {
        return { model }
      }
      return {
        model: modifyFields(model, { ceremony: () => Ceremony.CreatingWallet() }),
        commands: [CreateWallet({ name: walletNameOf(model) })],
      }
    },
    ClickedSignIn: () => {
      if (isBusy(model.ceremony)) {
        return { model }
      }
      return { model: modifyFields(model, { ceremony: () => Ceremony.SigningIn() }), commands: [SignIn()] }
    },
    SucceededCreateWallet: ({ wallet }) => ({
      model: modifyFields(model, { ceremony: () => Ceremony.Idle() }),
      outMessage: OutMessage.StartedSession({ wallet }),
    }),
    FailedCreateWallet: ({ problem }) => ({
      model: modifyFields(model, { ceremony: () => Ceremony.Failed({ error: problemMessage(problem) }) }),
    }),
    SucceededSignIn: ({ wallet }) => ({
      model: modifyFields(model, { ceremony: () => Ceremony.Idle() }),
      outMessage: OutMessage.StartedSession({ wallet }),
    }),
    FailedSignIn: ({ problem }) => ({
      model: modifyFields(model, { ceremony: () => Ceremony.Failed({ error: problemMessage(problem) }) }),
    }),
  })

// VIEW

const POINTS: ReadonlyArray<Readonly<{ title: string; body: string }>> = [
  {
    title: 'The limit lives on Stellar',
    body: 'Each AI app gets its own allowance and expiry, enforced by your Stellar account, not by our server.',
  },
  {
    title: 'Too big? It asks you',
    body: 'A payment over the allowance comes to you, and your passkey approves that exact recipient and amount.',
  },
  {
    title: 'No seed phrase, no gas',
    body: 'Your passkey owns the wallet, and Nod pays the network fee.',
  },
]

const pointView = (point: Readonly<{ title: string; body: string }>, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    point.title,
    [h.Class('flex flex-col gap-1')],
    [h.span([h.Class('font-semibold text-ink')], [point.title]), h.span([h.Class('text-sm text-muted')], [point.body])],
  )

const ceremonyNotice = (ceremony: Ceremony, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Ceremony.match<ReadonlyArray<Html>>(ceremony, {
    Idle: () => [],
    CreatingWallet: () => [
      h.p([h.AriaLive('polite'), h.Class('text-sm text-muted')], ['Follow your device’s passkey prompt…']),
    ],
    SigningIn: () => [
      h.p([h.AriaLive('polite'), h.Class('text-sm text-muted')], ['Follow your device’s passkey prompt…']),
    ],
    Failed: ({ error }) => [errorRow(error, h)],
  })

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [
      h.Class(
        'mx-auto flex min-h-dvh max-w-5xl flex-col justify-center gap-10 px-4 py-12 lg:flex-row lg:items-center lg:gap-16',
      ),
    ],
    [
      h.div(
        [h.Class('flex max-w-xl flex-col gap-6')],
        [
          h.p([h.Class('text-sm font-semibold tracking-tight text-accent')], ['nod']),
          h.h1(
            [h.Class('text-4xl font-semibold tracking-tight text-balance text-ink sm:text-5xl')],
            ['Give your AI an allowance.'],
          ),
          h.p(
            [h.Class('text-lg text-pretty text-muted')],
            [
              'Nod is a Stellar wallet you add to Claude. Small payments go through on their own, inside the allowance you set. Anything bigger waits for your nod.',
            ],
          ),
          h.ul(
            [h.Class('grid gap-4 sm:grid-cols-3 lg:grid-cols-1')],
            Array.map(POINTS, point => pointView(point, h)),
          ),
        ],
      ),
      h.div(
        [h.Class('flex w-full max-w-md flex-col gap-4 rounded-3xl border border-line bg-paper p-6 shadow-sm')],
        [
          h.h2([h.Class('text-lg font-semibold text-ink')], ['Start with a passkey']),
          h.form(
            [h.Class('flex flex-col gap-3'), h.OnSubmit(Message.SubmittedCreateWallet())],
            [
              h.label([h.For('wallet-name'), h.Class('text-sm font-medium text-ink')], ['Wallet name']),
              h.input([
                h.Id('wallet-name'),
                h.Type('text'),
                h.Value(model.walletName),
                h.Placeholder(DEFAULT_WALLET_NAME),
                h.Autocomplete('off'),
                h.Class(INPUT),
                h.OnInput(value => Message.UpdatedWalletName({ value })),
              ]),
              h.button(
                [
                  h.Type('submit'),
                  h.Disabled(isBusy(model.ceremony)),
                  h.DataAttribute('testid', 'create-wallet'),
                  h.Class(BUTTON_PRIMARY),
                ],
                [
                  Ceremony.matchOrElse(
                    model.ceremony,
                    { CreatingWallet: () => 'Creating your wallet…' },
                    () => 'Create your wallet',
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class('flex items-center gap-3 text-xs uppercase tracking-[0.14em] text-muted')],
            [h.span([h.Class('h-px flex-1 bg-line')]), 'or', h.span([h.Class('h-px flex-1 bg-line')])],
          ),
          h.button(
            [
              h.Type('button'),
              h.Disabled(isBusy(model.ceremony)),
              h.OnClick(Message.ClickedSignIn()),
              h.DataAttribute('testid', 'sign-in'),
              h.Class(BUTTON_SECONDARY),
            ],
            [
              Ceremony.matchOrElse(
                model.ceremony,
                { SigningIn: () => 'Signing in…' },
                () => 'Sign in with your passkey',
              ),
            ],
          ),
          ...ceremonyNotice(model.ceremony, h),
        ],
      ),
    ],
  ),
)
