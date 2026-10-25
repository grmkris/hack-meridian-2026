import { Effect, Option, Schema, String } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, Passkey, type Resources, WalletSummary } from '../backend'
import { Problem, recoverProblem } from '../problem'
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT, errorRow } from '../view/ui'
import * as Landing from './landing'

// MODEL

export const Ceremony = defineTaggedUnion({
  Idle: {},
  CreatingWallet: {},
  SigningIn: {},
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

export const Model = Schema.Struct({
  walletName: Schema.String,
  inviteCode: Schema.String,
  inviteField: InviteField,
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
  SucceededCreateWallet: { wallet: WalletSummary },
  FailedCreateWallet: { problem: Problem },
  SucceededSignIn: { wallet: WalletSummary },
  FailedSignIn: { problem: Problem },
  ClickedAddToClaude: {},
  CompletedCopyConnectorUrl: {},
  FailedCopyConnectorUrl: {},
  UpdatedInviteCode: { value: Schema.String },
  RequiredInviteCode: {},
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
  messages: [Message.SucceededCreateWallet, Message.FailedCreateWallet, Message.RequiredInviteCode],
  execute: ({ name, maybeInviteCode }) =>
    Effect.gen(function* () {
      const backend = yield* Backend
      const passkey = yield* Passkey
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

export const CopyConnectorUrl = Command.define('CopyConnectorUrl', {
  args: { url: Schema.String },
  messages: [Message.CompletedCopyConnectorUrl, Message.FailedCopyConnectorUrl],
  execute: ({ url }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(url)).pipe(
      Effect.as(Message.CompletedCopyConnectorUrl()),
      Effect.orElseSucceed(() => Message.FailedCopyConnectorUrl()),
    ),
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
      if (isBusy(model.ceremony) || !hasInviteIfShown(model)) {
        return { model }
      }
      return {
        model: modifyFields(model, { ceremony: () => Ceremony.CreatingWallet() }),
        commands: [CreateWallet({ name: walletNameOf(model), maybeInviteCode: inviteCodeOf(model) })],
      }
    },
    UpdatedInviteCode: ({ value }) => ({ model: modifyFields(model, { inviteCode: () => value }) }),
    RequiredInviteCode: () => ({
      model: modifyFields(model, { inviteField: () => InviteField.Shown(), ceremony: () => Ceremony.Idle() }),
    }),
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
    ClickedAddToClaude: () => ({ model, commands: [CopyConnectorUrl({ url: model.connectorUrl })] }),
    CompletedCopyConnectorUrl: () => ({ model: modifyFields(model, { copy: () => Copy.Copied() }) }),
    FailedCopyConnectorUrl: () => ({ model: modifyFields(model, { copy: () => Copy.Failed() }) }),
  })

// VIEW

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

const inviteFieldView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  InviteField.match<ReadonlyArray<Html>>(model.inviteField, {
    Hidden: () => [],
    Shown: () => [
      h.label([h.For('invite-code'), h.Class('text-sm font-medium text-ink')], ['Invite code']),
      h.input([
        h.Id('invite-code'),
        h.Type('text'),
        h.Value(model.inviteCode),
        h.Autocomplete('off'),
        h.Spellcheck(false),
        h.Required(true),
        h.AriaDescribedBy('invite-code-hint'),
        h.DataAttribute('testid', 'invite-code'),
        h.Class(`${INPUT} font-mono`),
        h.OnInput(value => Message.UpdatedInviteCode({ value })),
      ]),
      h.p(
        [h.Id('invite-code-hint'), h.Role('status'), h.Class('text-sm text-muted')],
        ['Nod on this network is invite-only for now. Enter your invite code, then create your wallet.'],
      ),
    ],
  })

export const walletFormView = (model: Model, h: HtmlBuilder<Message>): Html =>
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
          ...inviteFieldView(model, h),
          h.button(
            [
              h.Type('submit'),
              h.Disabled(isBusy(model.ceremony) || !hasInviteIfShown(model)),
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
        [Ceremony.matchOrElse(model.ceremony, { SigningIn: () => 'Signing in…' }, () => 'Sign in with your passkey')],
      ),
      ...ceremonyNotice(model.ceremony, h),
    ],
  )

export const addToClaudeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex w-full max-w-md flex-col gap-2')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedAddToClaude()),
          h.DataAttribute('testid', 'add-to-claude'),
          h.Class(BUTTON_SECONDARY),
        ],
        [
          Copy.match(model.copy, {
            Idle: () => 'Add to Claude',
            Copied: () => 'Copied. Paste it in Claude’s connectors',
            Failed: () => 'Add to Claude',
          }),
        ],
      ),
      h.p(
        [h.Class('text-center text-sm text-muted')],
        [
          Copy.matchOrElse(model.copy, { Failed: () => 'Copy this connector URL: ' }, () => 'Connector URL: '),
          h.code([h.Class('select-all break-all font-mono text-xs text-ink')], [model.connectorUrl]),
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
    },
    h,
  ),
)
