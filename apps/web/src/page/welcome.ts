import { Effect, Option, Schema, String } from 'effect'
import { Command, Dom, Mount, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, Passkey, type Resources, WalletSummary } from '../backend'
import { Problem, recoverProblem } from '../problem'
import { errorRow } from '../view/ui'
import * as Landing from './landing'

// MODEL

export const Ceremony = defineTaggedUnion({
  Idle: {},
  CreatingWallet: {},
  SigningIn: {},
  Unavailable: {},
  Failed: { error: Schema.String },
})
export type Ceremony = typeof Ceremony.Type

export const Copy = defineTaggedUnion({
  Idle: {},
  Copied: {},
  Failed: {},
})
export type Copy = typeof Copy.Type

export const InviteField = defineTaggedUnion({
  Hidden: {},
  Shown: {},
})
export type InviteField = typeof InviteField.Type

export const EntryMode = defineTaggedUnion({
  SignIn: {},
  Choice: {},
  Creating: {},
})
export type EntryMode = typeof EntryMode.Type

export const Model = Schema.Struct({
  walletName: Schema.String,
  inviteCode: Schema.String,
  inviteField: InviteField,
  entryMode: EntryMode,
  ceremony: Ceremony,
  connectorUrl: Schema.String,
  copy: Copy,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedWalletName: { value: Schema.String },
  SubmittedCreateWallet: {},
  ClickedSignIn: {},
  ClickedCreateWallet: {},
  ClickedBackToSignIn: {},
  UnavailablePasskey: {},
  CompletedFocusWalletName: {},
  CompletedFocusConnectWallet: {},
  SucceededCreateWallet: { wallet: WalletSummary },
  FailedCreateWallet: { problem: Problem },
  SucceededSignIn: { wallet: WalletSummary },
  FailedSignIn: { problem: Problem },
  ClickedAddToClaude: {},
  CompletedCopyConnectorUrl: {},
  FailedCopyConnectorUrl: {},
  UpdatedInviteCode: { value: Schema.String },
  RequiredInviteCode: {},
  SettledNightFlight: { playing: Schema.Boolean },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ StartedSession: { wallet: WalletSummary } })
export type OutMessage = typeof OutMessage.Type

// INIT

const DEFAULT_WALLET_NAME = 'Personal'

export const init = (
  maybeError: Option.Option<string>,
  connectorUrl: string,
): Update.Return<Model, Message, Resources> => ({
  model: {
    walletName: DEFAULT_WALLET_NAME,
    connectorUrl,
    copy: Copy.Idle(),
    inviteCode: '',
    inviteField: InviteField.Hidden(),
    entryMode: EntryMode.SignIn(),
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
  args: { name: Schema.String, maybeInviteCode: Schema.Option(Schema.String) },
  messages: [
    Message.SucceededCreateWallet,
    Message.FailedCreateWallet,
    Message.RequiredInviteCode,
    Message.UnavailablePasskey,
  ],
  execute: ({ name, maybeInviteCode }) =>
    Effect.gen(function* () {
      const backend = yield* Backend
      const passkey = yield* Passkey
      if (!(yield* passkey.supported)) {
        return Message.UnavailablePasskey()
      }
      const options = yield* backend.registrationOptions(name, maybeInviteCode)
      const created = yield* passkey.create(options)
      const wallet = yield* backend.createWallet(
        Option.match(maybeInviteCode, {
          onNone: () => ({ name, ...created }),
          onSome: inviteCode => ({ name, ...created, invite_code: inviteCode }),
        }),
      )
      return Message.SucceededCreateWallet({ wallet })
    }).pipe(
      Effect.catchTag('InviteRequired', () => Effect.succeed(Message.RequiredInviteCode())),
      recoverProblem(problem => Message.FailedCreateWallet({ problem })),
    ),
})

export const SignIn = Command.define('SignIn', {
  messages: [Message.SucceededSignIn, Message.FailedSignIn, Message.UnavailablePasskey],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const passkey = yield* Passkey
    if (!(yield* passkey.supported)) {
      return Message.UnavailablePasskey()
    }
    const options = yield* backend.assertionOptions
    const assertion = yield* passkey.assert(options)
    const wallet = yield* backend.signIn(assertion)
    return Message.SucceededSignIn({ wallet })
  }).pipe(recoverProblem(problem => Message.FailedSignIn({ problem }))),
})

export const FocusWalletName = Command.define('FocusWalletName', {
  messages: [Message.CompletedFocusWalletName],
  execute: Dom.focus('#wallet-name').pipe(
    Effect.as(Message.CompletedFocusWalletName()),
    Effect.orElseSucceed(() => Message.CompletedFocusWalletName()),
  ),
})

export const FocusConnectWallet = Command.define('FocusConnectWallet', {
  messages: [Message.CompletedFocusConnectWallet],
  execute: Dom.focus('#connect-wallet').pipe(
    Effect.as(Message.CompletedFocusConnectWallet()),
    Effect.orElseSucceed(() => Message.CompletedFocusConnectWallet()),
  ),
})

export const CopyConnectorUrl = Command.define('CopyConnectorUrl', {
  args: { url: Schema.String },
  messages: [Message.CompletedCopyConnectorUrl, Message.FailedCopyConnectorUrl],
  execute: ({ url }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(url)).pipe(
      Effect.as(Message.CompletedCopyConnectorUrl()),
      Effect.orElseSucceed(() => Message.FailedCopyConnectorUrl()),
    ),
})

const NetworkInformation = Schema.Struct({ saveData: Schema.Boolean })

/** The hero's moving etching plays when motion is welcome and the visitor is not saving data. */
const wantsNightFlight = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: no-preference)').matches &&
  !Option.exists(
    Schema.decodeUnknownOption(NetworkInformation)(Reflect.get(navigator, 'connection')),
    ({ saveData }) => saveData,
  )

/**
 * Loops the night flight with the transition baked into its asset. The video has no
 * source until this decides to play it, so reduced motion or Save-Data never downloads it. Slow connections keep
 * the etching visible while loading; autoplay refusal keeps it still. Unmount cancels a pending load.
 */
export const PlayNightFlight = Mount.define('PlayNightFlight', {
  args: { src: Schema.String },
  messages: [Message.SettledNightFlight],
  execute: ({ element, src }) =>
    Effect.gen(function* () {
      if (!(element instanceof HTMLVideoElement) || !wantsNightFlight()) {
        return Message.SettledNightFlight({ playing: false })
      }
      const releaseVideo = Effect.sync(() => {
        element.pause()
        element.removeAttribute('src')
        element.load()
        delete element.dataset['playing']
      })
      yield* Effect.addFinalizer(() => releaseVideo)
      element.muted = true
      element.playsInline = true
      element.src = src
      const playing = yield* Effect.tryPromise(() => element.play()).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (playing) {
        element.dataset['playing'] = 'true'
      } else {
        yield* releaseVideo
      }
      return Message.SettledNightFlight({ playing })
    }),
})

// UPDATE

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const isBusy = (ceremony: Ceremony): boolean =>
  Ceremony.match<boolean>(ceremony, {
    Idle: () => false,
    CreatingWallet: () => true,
    SigningIn: () => true,
    Unavailable: () => false,
    Failed: () => false,
  })

const inviteCodeOf = (model: Model): Option.Option<string> =>
  InviteField.match(model.inviteField, {
    Hidden: () => Option.none(),
    Shown: () => Option.liftPredicate(String.trim(model.inviteCode), String.isNonEmpty),
  })

const hasInviteIfShown = (model: Model): boolean =>
  InviteField.match(model.inviteField, { Hidden: () => true, Shown: () => Option.isSome(inviteCodeOf(model)) })

const walletNameOf = (model: Model): string => {
  const trimmed = String.trim(model.walletName)
  return String.isEmpty(trimmed) ? DEFAULT_WALLET_NAME : trimmed
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedWalletName: ({ value }) => ({ model: modifyFields(model, { walletName: () => value }) }),
    SubmittedCreateWallet: () => {
      if (isBusy(model.ceremony) || !hasInviteIfShown(model) || !EntryMode.guards.Creating(model.entryMode)) {
        return { model }
      }
      return {
        model: modifyFields(model, { ceremony: () => Ceremony.CreatingWallet() }),
        commands: [CreateWallet({ name: walletNameOf(model), maybeInviteCode: inviteCodeOf(model) })],
      }
    },
    UpdatedInviteCode: ({ value }) => ({ model: modifyFields(model, { inviteCode: () => value }) }),
    ClickedCreateWallet: () =>
      isBusy(model.ceremony)
        ? { model }
        : {
            model: modifyFields(model, { entryMode: () => EntryMode.Creating(), ceremony: () => Ceremony.Idle() }),
            commands: [FocusWalletName()],
          },
    ClickedBackToSignIn: () =>
      isBusy(model.ceremony)
        ? { model }
        : {
            model: modifyFields(model, { entryMode: () => EntryMode.SignIn(), ceremony: () => Ceremony.Idle() }),
            commands: [FocusConnectWallet()],
          },
    UnavailablePasskey: () => ({ model: modifyFields(model, { ceremony: () => Ceremony.Unavailable() }) }),
    CompletedFocusWalletName: () => ({ model }),
    CompletedFocusConnectWallet: () => ({ model }),
    RequiredInviteCode: () => ({
      model: modifyFields(model, { inviteField: () => InviteField.Shown(), ceremony: () => Ceremony.Idle() }),
    }),
    ClickedSignIn: () => {
      if (isBusy(model.ceremony)) {
        return { model }
      }
      return {
        model: modifyFields(model, { entryMode: () => EntryMode.SignIn(), ceremony: () => Ceremony.SigningIn() }),
        commands: [SignIn()],
      }
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
      model: modifyFields(model, {
        entryMode: () => EntryMode.Choice(),
        ceremony: () => Ceremony.Failed({ error: problemMessage(problem) }),
      }),
      commands: [FocusConnectWallet()],
    }),
    ClickedAddToClaude: () => ({ model, commands: [CopyConnectorUrl({ url: model.connectorUrl })] }),
    CompletedCopyConnectorUrl: () => ({ model: modifyFields(model, { copy: () => Copy.Copied() }) }),
    FailedCopyConnectorUrl: () => ({ model: modifyFields(model, { copy: () => Copy.Failed() }) }),
    SettledNightFlight: () => ({ model }),
  })

// VIEW

const ceremonyNotice = (ceremony: Ceremony, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Ceremony.match<ReadonlyArray<Html>>(ceremony, {
    Idle: () => [],
    CreatingWallet: () => [
      h.p([h.AriaLive('polite'), h.Class('landing-hint')], ['Follow your device’s passkey prompt…']),
    ],
    SigningIn: () => [h.p([h.AriaLive('polite'), h.Class('landing-hint')], ['Follow your device’s passkey prompt…'])],
    Unavailable: () => [
      h.p(
        [h.Role('status'), h.Class('landing-hint')],
        ['This browser cannot use passkeys. Open Nod in Safari, Chrome, or another browser that supports them.'],
      ),
    ],
    Failed: ({ error }) => [errorRow(error, h)],
  })

const inviteFieldView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  InviteField.match<ReadonlyArray<Html>>(model.inviteField, {
    Hidden: () => [],
    Shown: () => [
      h.label([h.For('invite-code'), h.Class('landing-label')], ['Invite code']),
      h.input([
        h.Id('invite-code'),
        h.Type('text'),
        h.Value(model.inviteCode),
        h.Autocomplete('off'),
        h.Spellcheck(false),
        h.Required(true),
        h.AriaDescribedBy('invite-code-hint'),
        h.DataAttribute('testid', 'invite-code'),
        h.Class('landing-input landing-input-code'),
        h.OnInput(value => Message.UpdatedInviteCode({ value })),
      ]),
      h.p(
        [h.Id('invite-code-hint'), h.Role('status'), h.Class('landing-hint')],
        ['Nod on this network is invite-only for now. Enter your invite code, then create your wallet.'],
      ),
    ],
  })

const signInButton = (label: string, model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Id('connect-wallet'),
      h.Type('button'),
      h.Disabled(isBusy(model.ceremony)),
      h.OnClick(Message.ClickedSignIn()),
      h.DataAttribute('testid', 'sign-in'),
      h.Class('landing-button landing-button-primary'),
    ],
    [label],
  )

const signInView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-start')],
    [
      signInButton(
        Ceremony.matchOrElse(model.ceremony, { SigningIn: () => 'Connecting…' }, () => 'Connect wallet'),
        model,
        h,
      ),
      ...ceremonyNotice(model.ceremony, h),
      h.p([h.Class('landing-hint')], ['Sign in with your passkey. New to Nod? You can create one next.']),
    ],
  )

const entryChoiceView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-start')],
    [
      ...ceremonyNotice(model.ceremony, h),
      h.div(
        [h.Class('landing-entry-actions')],
        [
          signInButton('Try signing in again', model, h),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCreateWallet()),
              h.DataAttribute('testid', 'choose-create-wallet'),
              h.Class('landing-button landing-button-quiet'),
            ],
            ['Create a new wallet'],
          ),
        ],
      ),
    ],
  )

const createWalletView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-start')],
    [
      h.h2([h.Class('landing-start-title')], ['Create a new wallet']),
      h.form(
        [h.Class('landing-start-form'), h.OnSubmit(Message.SubmittedCreateWallet())],
        [
          ...inviteFieldView(model, h),
          h.label([h.For('wallet-name'), h.Class('landing-label')], ['Wallet name']),
          h.div(
            [h.Class('landing-start-row')],
            [
              h.input([
                h.Id('wallet-name'),
                h.Type('text'),
                h.Value(model.walletName),
                h.Placeholder(DEFAULT_WALLET_NAME),
                h.Autocomplete('off'),
                h.Maxlength(40),
                h.Class('landing-input'),
                h.Disabled(isBusy(model.ceremony)),
                h.OnInput(value => Message.UpdatedWalletName({ value })),
              ]),
              h.button(
                [
                  h.Type('submit'),
                  h.Disabled(isBusy(model.ceremony) || !hasInviteIfShown(model)),
                  h.DataAttribute('testid', 'create-wallet'),
                  h.Class('landing-button landing-button-primary'),
                ],
                [
                  Ceremony.matchOrElse(
                    model.ceremony,
                    { CreatingWallet: () => 'Creating your wallet…' },
                    () => 'Create with a passkey',
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      ...ceremonyNotice(model.ceremony, h),
      h.p([h.Class('landing-hint')], ['Your device will save a new passkey for this wallet.']),
      h.button(
        [
          h.Type('button'),
          h.Disabled(isBusy(model.ceremony)),
          h.OnClick(Message.ClickedBackToSignIn()),
          h.Class('landing-text-button'),
        ],
        ['Back to sign in'],
      ),
    ],
  )

export const walletFormView = (model: Model, h: HtmlBuilder<Message>): Html =>
  EntryMode.match(model.entryMode, {
    SignIn: () => signInView(model, h),
    Choice: () => entryChoiceView(model, h),
    Creating: () => createWalletView(model, h),
  })

export const addToClaudeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-connector')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedAddToClaude()),
          h.DataAttribute('testid', 'add-to-claude'),
          h.Class('landing-button landing-button-quiet'),
        ],
        [
          Copy.match(model.copy, {
            Idle: () => 'Copy connector URL',
            Copied: () => 'Copied. Paste it in Claude’s connectors',
            Failed: () => 'Copy connector URL',
          }),
        ],
      ),
      h.p(
        [h.Class('landing-connector-url')],
        [
          Copy.matchOrElse(model.copy, { Failed: () => 'Copy this connector URL: ' }, () => 'Connector URL: '),
          h.code([], [model.connectorUrl]),
        ],
      ),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  Landing.view(
    {
      walletForm: walletFormView(model, h),
      addToClaude: addToClaudeView(model, h),
      connectorUrl: model.connectorUrl,
      nightFlight: h.OnMount(PlayNightFlight({ src: Landing.NIGHT_FLIGHT_SRC })),
    },
    h,
  ),
)
