import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { Command, Port, Runtime, Subscription, type Update } from 'foldkit'
import { File } from 'foldkit/file'
import type { HtmlBuilder } from 'foldkit/html'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { RecipientReadOutput, RecipientScanOutput } from '@hm/protocol'

import { decodeCapabilities, mergeAppearance } from '../decode'
import { Host, HostFailed, toToolReply } from '../host'
import { Appearance } from '../model'
import { CAMERA_ID, OpenCamera, qrReason, readCamera, readImage } from './media'
import { Message } from './message'

export const Phase = defineTaggedUnion({
  Idle: {},
  Camera: { ready: Schema.Boolean },
  Reading: {},
  Review: { recipient: RecipientReadOutput },
  Sharing: { recipient: RecipientReadOutput },
  Shared: { recipient: RecipientReadOutput },
  Failed: { reason: Schema.String },
})
export type Phase = typeof Phase.Type
export const Model = Schema.Struct({
  phase: Phase,
  attempt: Schema.Int,
  appearance: Appearance,
  canCallTools: Schema.Boolean,
  maybeNetwork: Schema.Option(Schema.String),
  maybeNotice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
export const init = () => ({
  model: {
    phase: Phase.Idle(),
    attempt: 0,
    appearance: { maybeTheme: Option.none(), variables: {}, isFullscreen: false },
    canCallTools: false,
    maybeNetwork: Option.none(),
    maybeNotice: Option.none(),
  },
})

const validate = Effect.fn('scanner.validate')(function* (text: string) {
  if (!/^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u.test(text.trim())) {
    return yield* new HostFailed({
      reason:
        'The QR must contain a Stellar G, C or M address. Payment links, memos and secret keys are not supported.',
    })
  }
  const host = yield* Host
  const reply = yield* host.callTool('recipient_read', { text: text.trim() })
  if (reply.isError) return yield* new HostFailed({ reason: reply.text })
  return yield* Schema.decodeUnknownEffect(RecipientReadOutput)(reply.structured).pipe(
    Effect.mapError(() => new HostFailed({ reason: 'Nod could not validate the address. Try again.' })),
  )
})

export const ReadImage = Command.define('ReadImage', {
  args: { file: File, attempt: Schema.Int },
  messages: [Message.SucceededRead, Message.FailedRead],
  execute: ({ file, attempt }) =>
    Effect.tryPromise({ try: () => readImage(file), catch: error => new HostFailed({ reason: qrReason(error) }) }).pipe(
      Effect.flatMap(validate),
      Effect.map(recipient => Message.SucceededRead({ attempt, recipient })),
      Effect.catch(error => Effect.succeed(Message.FailedRead({ attempt, reason: error.reason }))),
    ),
})
export const CaptureQr = Command.define('CaptureQr', {
  args: { attempt: Schema.Int },
  messages: [Message.SucceededRead, Message.FailedRead],
  execute: ({ attempt }) =>
    Effect.try({ try: readCamera, catch: error => new HostFailed({ reason: qrReason(error) }) }).pipe(
      Effect.flatMap(validate),
      Effect.map(recipient => Message.SucceededRead({ attempt, recipient })),
      Effect.catch(error => Effect.succeed(Message.FailedRead({ attempt, reason: error.reason }))),
    ),
})
export const ShareRecipient = Command.define('ShareRecipient', {
  args: { recipient: RecipientReadOutput, attempt: Schema.Int },
  messages: [Message.SucceededShare, Message.FailedShare],
  execute: ({ recipient, attempt }) =>
    Effect.gen(function* () {
      const host = yield* Host
      yield* host.sendMessage(`I selected this recipient for my payment: ${recipient.address} (${recipient.network}).`)
      return Message.SucceededShare({ attempt })
    }).pipe(Effect.catch(error => Effect.succeed(Message.FailedShare({ attempt, reason: error.reason })))),
})
export const CopyRecipient = Command.define('CopyRecipient', {
  args: { address: Schema.String, attempt: Schema.Int },
  messages: [Message.CompletedCopy],
  execute: ({ address, attempt }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(address)).pipe(
      Effect.as(Message.CompletedCopy({ attempt, copied: true })),
      Effect.orElseSucceed(() => Message.CompletedCopy({ attempt, copied: false })),
    ),
})

const reset = (model: Model) => ({
  model: modifyFields(model, { phase: () => Phase.Idle(), attempt: n => n + 1, maybeNotice: () => Option.none() }),
})
const recipientOf = (phase: Phase) =>
  Phase.match<Option.Option<RecipientReadOutput>>(phase, {
    Idle: () => Option.none(),
    Camera: () => Option.none(),
    Reading: () => Option.none(),
    Failed: () => Option.none(),
    Review: ({ recipient }) => Option.some(recipient),
    Sharing: ({ recipient }) => Option.some(recipient),
    Shared: ({ recipient }) => Option.some(recipient),
  })
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, Host>>(message, {
    Connected: ({ capabilities, context }) => ({
      model: modifyFields(model, {
        canCallTools: () => decodeCapabilities(capabilities).canCallTools,
        appearance: a => mergeAppearance(a, context),
      }),
    }),
    ReceivedContext: ({ context }) => ({
      model: modifyFields(model, { appearance: a => mergeAppearance(a, context) }),
    }),
    ReceivedResult: ({ result }) =>
      Option.match(Schema.decodeUnknownOption(RecipientScanOutput)(toToolReply(result).structured), {
        onNone: () => ({ model }),
        onSome: scan => ({ model: modifyFields(model, { maybeNetwork: () => Option.some(scan.network) }) }),
      }),
    FailedConnection: () => ({
      model: modifyFields(model, {
        maybeNotice: () =>
          Option.some('This chat could not connect the scanner. Ask the AI to read your attached QR image.'),
      }),
    }),
    ClickedCamera: () =>
      model.canCallTools
        ? {
            model: modifyFields(model, {
              phase: () => Phase.Camera({ ready: false }),
              attempt: n => n + 1,
              maybeNotice: () => Option.none(),
            }),
          }
        : { model },
    SucceededCamera: ({ attempt }) => ({
      model:
        attempt === model.attempt && model.phase._tag === 'Camera'
          ? modifyFields(model, { phase: () => Phase.Camera({ ready: true }) })
          : model,
    }),
    FailedCamera: ({ attempt, reason }) => ({
      model: attempt === model.attempt ? modifyFields(model, { phase: () => Phase.Failed({ reason }) }) : model,
    }),
    ClickedCapture: () =>
      model.phase._tag === 'Camera' && model.phase.ready
        ? {
            model: modifyFields(model, { phase: () => Phase.Camera({ ready: false }) }),
            commands: [CaptureQr({ attempt: model.attempt })],
          }
        : { model },
    SelectedFiles: ({ files }) => {
      const file = files[0]
      if (file === undefined || !model.canCallTools) return { model }
      const attempt = model.attempt + 1
      return {
        model: modifyFields(model, {
          phase: () => Phase.Reading(),
          attempt: () => attempt,
          maybeNotice: () => Option.none(),
        }),
        commands: [ReadImage({ file, attempt })],
      }
    },
    SucceededRead: ({ attempt, recipient }) => ({
      model: attempt === model.attempt ? modifyFields(model, { phase: () => Phase.Review({ recipient }) }) : model,
    }),
    FailedRead: ({ attempt, reason }) => ({
      model: attempt === model.attempt ? modifyFields(model, { phase: () => Phase.Failed({ reason }) }) : model,
    }),
    ClickedReset: () => reset(model),
    BecameHidden: () => (model.phase._tag === 'Camera' ? reset(model) : { model }),
    ClickedUse: () => {
      const phase = model.phase
      if (phase._tag !== 'Review') return { model }
      return {
        model: modifyFields(model, { phase: () => Phase.Sharing({ recipient: phase.recipient }) }),
        commands: [ShareRecipient({ recipient: phase.recipient, attempt: model.attempt })],
      }
    },
    SucceededShare: ({ attempt }) => ({
      model:
        attempt === model.attempt && model.phase._tag === 'Sharing'
          ? modifyFields(model, {
              phase: () =>
                model.phase._tag === 'Sharing' ? Phase.Shared({ recipient: model.phase.recipient }) : model.phase,
            })
          : model,
    }),
    FailedShare: ({ attempt, reason }) => ({
      model:
        attempt === model.attempt && model.phase._tag === 'Sharing'
          ? modifyFields(model, {
              phase: () =>
                model.phase._tag === 'Sharing' ? Phase.Review({ recipient: model.phase.recipient }) : model.phase,
              maybeNotice: () => Option.some(`${reason} Copy the address into the chat instead.`),
            })
          : model,
    }),
    ClickedCopy: () =>
      Option.match(recipientOf(model.phase), {
        onNone: () => ({ model }),
        onSome: recipient => ({
          model,
          commands: [CopyRecipient({ address: recipient.address, attempt: model.attempt })],
        }),
      }),
    CompletedCopy: ({ attempt, copied }) => ({
      model:
        attempt === model.attempt
          ? modifyFields(model, {
              maybeNotice: () =>
                Option.some(
                  copied ? 'Address copied.' : 'Select the full address above and copy it into your message.',
                ),
            })
          : model,
    }),
  })

type Builder = HtmlBuilder<Message>
const button = (text: string, message: Message, h: Builder, disabled = false) =>
  h.button([h.Type('button'), h.Class('nod-button'), h.Disabled(disabled), h.OnClick(message)], [text])
const cameraView = (model: Model, ready: boolean, h: Builder) =>
  h.div(
    [h.Class('nod-scan-camera')],
    [
      h.video([
        h.Id(CAMERA_ID),
        h.Class('nod-scan-video'),
        h.Attribute('playsinline', ''),
        h.Attribute('muted', ''),
        h.OnMount(OpenCamera({ attempt: model.attempt })),
      ]),
      h.p([h.Class('nod-note')], [ready ? 'Frame one QR code, then capture it.' : 'Allow camera access to continue.']),
      button('Capture QR code', Message.ClickedCapture(), h, !ready),
    ],
  )
const reviewView = (recipient: RecipientReadOutput, status: 'review' | 'sharing' | 'shared', h: Builder) =>
  h.div(
    [h.Class('nod-scan-review')],
    [
      h.p(
        [h.Class('nod-lead')],
        [status === 'shared' ? 'Recipient sent to the chat.' : 'Check the full recipient address.'],
      ),
      h.p([h.Class('nod-address nod-mono nod-select'), h.Attribute('dir', 'ltr')], [recipient.address]),
      h.p(
        [h.Class('nod-note')],
        [
          `${recipient.address_kind} · ${recipient.network === 'stellar:testnet' ? 'Testnet' : 'Mainnet'} wallet. An address does not identify its network.`,
        ],
      ),
      h.div(
        [h.Class('nod-actions')],
        [
          status === 'shared'
            ? h.empty
            : button(
                status === 'sharing' ? 'Sending…' : 'Use this recipient',
                Message.ClickedUse(),
                h,
                status === 'sharing',
              ),
          button('Copy address', Message.ClickedCopy(), h),
        ],
      ),
    ],
  )
export const view = (model: Model, h: Builder) =>
  h.main(
    [
      h.Class('nod'),
      h.DataAttribute(
        'theme',
        Option.match(model.appearance.maybeTheme, {
          onNone: () => 'auto',
          onSome: t => (t === 'Dark' ? 'dark' : 'light'),
        }),
      ),
      h.Style(model.appearance.variables),
    ],
    [
      h.header(
        [h.Class('nod-header')],
        [
          h.span([h.Class('nod-wordmark')], ['nod']),
          Option.match(model.maybeNetwork, {
            onNone: () => h.empty,
            onSome: n => h.span([h.Class('nod-network')], [n === 'stellar:testnet' ? 'Testnet' : 'Mainnet']),
          }),
        ],
      ),
      h.h1([h.Class('nod-headline')], ['Scan a recipient']),
      h.p(
        [h.Class('nod-note')],
        ['Choose their QR image or use your camera. Scanning does not pay or save a contact.'],
      ),
      Phase.match(model.phase, {
        Idle: () => h.empty,
        Camera: ({ ready }) => cameraView(model, ready, h),
        Reading: () => h.p([h.Role('status')], ['Reading QR code…']),
        Failed: ({ reason }) => h.p([h.Class('nod-tone-bad'), h.Role('alert')], [reason]),
        Review: ({ recipient }) => reviewView(recipient, 'review', h),
        Sharing: ({ recipient }) => reviewView(recipient, 'sharing', h),
        Shared: ({ recipient }) => reviewView(recipient, 'shared', h),
      }),
      model.phase._tag === 'Idle' || model.phase._tag === 'Failed'
        ? h.div(
            [h.Class('nod-scan-options')],
            [
              button('Open camera', Message.ClickedCamera(), h, !model.canCallTools),
              h.label(
                [h.Class('nod-scan-file')],
                [
                  'Choose QR image',
                  h.input([
                    h.Type('file'),
                    h.Accept('image/png,image/jpeg'),
                    h.Disabled(!model.canCallTools),
                    h.OnFileChange(files => Message.SelectedFiles({ files })),
                  ]),
                ],
              ),
              h.p([h.Class('nod-note')], ['PNG or JPEG, up to 5 MB. Camera access depends on this chat.']),
            ],
          )
        : button(
            model.phase._tag === 'Camera' || model.phase._tag === 'Reading' ? 'Cancel' : 'Scan another',
            Message.ClickedReset(),
            h,
            model.phase._tag === 'Sharing',
          ),
      !model.canCallTools
        ? h.p(
            [h.Class('nod-note'), h.Role('status')],
            ['This chat must allow cards to call Nod tools. You can also attach a QR image in the chat.'],
          )
        : h.empty,
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: text => h.p([h.Class('nod-note'), h.Role('status')], [text]),
      }),
    ],
  )

export const ports = {
  inbound: {
    connected: Port.inbound(Schema.Struct({ capabilities: Schema.Unknown, context: Schema.Unknown })),
    context: Port.inbound(Schema.Unknown),
    result: Port.inbound(Schema.Unknown),
    failed: Port.inbound(Schema.Void),
    cancelled: Port.inbound(Schema.Void),
  },
}
const subscriptions = Subscription.make<Model, Message, Host>()(() => ({
  connected: Port.subscriptionEntry(ports.inbound.connected, Message.Connected),
  context: Port.subscriptionEntry(ports.inbound.context, context => Message.ReceivedContext({ context })),
  result: Port.subscriptionEntry(ports.inbound.result, result => Message.ReceivedResult({ result })),
  failed: Port.subscriptionEntry(ports.inbound.failed, Message.FailedConnection),
  cancelled: Port.subscriptionEntry(ports.inbound.cancelled, Message.ClickedReset),
  visibility: Subscription.persistentEntry(
    Stream.fromEventListener(document, 'visibilitychange').pipe(
      Stream.filter(() => document.visibilityState !== 'visible'),
      Stream.map(() => Message.BecameHidden()),
    ),
  ),
  pagehide: Subscription.persistentEntry(
    Stream.fromEventListener(window, 'pagehide').pipe(Stream.map(() => Message.BecameHidden())),
  ),
}))
export const makeScanner = (container: HTMLElement, host: Layer.Layer<Host>) =>
  Runtime.makeElement({ Model, init, update, view, subscriptions, ports, container, resources: host })
