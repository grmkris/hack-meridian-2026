import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, GrantView, type Resources, RevokeReply } from '../backend'
import { dateTime, percentUsed, usdc } from '../format'
import { Problem, recoverProblem } from '../problem'
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  badge,
  emptyRow,
  errorRow,
  loadingRow,
  meter,
  pageHeader,
} from '../view/ui'

// MODEL

export const ConnectionsData = AsyncData.Schema(Schema.Array(GrantView), Schema.String)

export const Revoke = defineTaggedUnion({
  Idle: {},
  Confirming: { connectionId: Schema.String },
  Revoking: { connectionId: Schema.String },
  Failed: { connectionId: Schema.String, error: Schema.String },
})
export type Revoke = typeof Revoke.Type

export const Model = Schema.Struct({
  connections: ConnectionsData.schema,
  revoke: Revoke,
  maybeRuleRemovalUrl: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  EnteredPage: {},
  SucceededLoadConnections: { connections: Schema.Array(GrantView) },
  FailedLoadConnections: { problem: Problem },
  ClickedRevoke: { connectionId: Schema.String },
  ClickedCancelRevoke: {},
  ClickedConfirmRevoke: { connectionId: Schema.String },
  SucceededRevokeConnection: { reply: RevokeReply },
  FailedRevokeConnection: { connectionId: Schema.String, problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ EndedSession: {} })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Update.Return<Model, Message, Resources> => ({
  model: { connections: ConnectionsData.Idle(), revoke: Revoke.Idle(), maybeRuleRemovalUrl: Option.none() },
})

// COMMAND

export const LoadConnections = Command.define('LoadConnections', {
  messages: [Message.SucceededLoadConnections, Message.FailedLoadConnections],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const connections = yield* backend.connections
    return Message.SucceededLoadConnections({ connections })
  }).pipe(recoverProblem(problem => Message.FailedLoadConnections({ problem }))),
})

export const RevokeConnection = Command.define('RevokeConnection', {
  args: { connectionId: Schema.String },
  messages: [Message.SucceededRevokeConnection, Message.FailedRevokeConnection],
  execute: ({ connectionId }) =>
    Effect.gen(function* () {
      const backend = yield* Backend
      const reply = yield* backend.revokeConnection(connectionId)
      return Message.SucceededRevokeConnection({ reply })
    }).pipe(recoverProblem(problem => Message.FailedRevokeConnection({ connectionId, problem }))),
})

// UPDATE

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const endSession = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { connections: () => ConnectionsData.Idle(), revoke: () => Revoke.Idle() }),
  outMessage: OutMessage.EndedSession(),
})

const replaceConnection =
  (next: GrantView) =>
  (connections: ReadonlyArray<GrantView>): ReadonlyArray<GrantView> =>
    Array.map(connections, connection => (connection.connection_id === next.connection_id ? next : connection))

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () =>
      Option.match(AsyncData.revalidateOrLoad(model.connections), {
        onNone: () => ({ model }),
        onSome: nextConnections => ({
          model: modifyFields(model, { connections: () => nextConnections }),
          commands: [LoadConnections()],
        }),
      }),
    SucceededLoadConnections: ({ connections }) => ({
      model: modifyFields(model, { connections: () => ConnectionsData.Success({ data: connections }) }),
    }),
    FailedLoadConnections: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => endSession(model),
        Failed: ({ error }) => ({
          model: modifyFields(model, { connections: () => ConnectionsData.Failure({ error }) }),
        }),
      }),
    ClickedRevoke: ({ connectionId }) => ({
      model: modifyFields(model, { revoke: () => Revoke.Confirming({ connectionId }) }),
    }),
    ClickedCancelRevoke: () => ({ model: modifyFields(model, { revoke: () => Revoke.Idle() }) }),
    ClickedConfirmRevoke: ({ connectionId }) => ({
      model: modifyFields(model, { revoke: () => Revoke.Revoking({ connectionId }) }),
      commands: [RevokeConnection({ connectionId })],
    }),
    SucceededRevokeConnection: ({ reply }) => ({
      model: modifyFields(model, {
        connections: AsyncData.map(replaceConnection(reply.connection)),
        revoke: () => Revoke.Idle(),
        maybeRuleRemovalUrl: () => Option.fromNullishOr(reply.approve_url),
      }),
    }),
    FailedRevokeConnection: ({ connectionId, problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => endSession(model),
        Failed: ({ error }) => ({
          model: modifyFields(model, { revoke: () => Revoke.Failed({ connectionId, error }) }),
        }),
      }),
  })

export const informEntered = (model: Model) => update(model, Message.EnteredPage())

// VIEW

const ruleLabel = (connection: GrantView): string =>
  Option.match(Option.fromNullishOr(connection.rule_status), {
    onNone: () => 'No onchain allowance yet',
    onSome: status =>
      ({
        installed: 'Onchain rule installed',
        removal_pending: 'Onchain rule being removed',
        removed: 'Onchain rule removed',
      })[status],
  })

const revokeControls = (connection: GrantView, revoke: Revoke, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const isThis = (connectionId: string) => connectionId === connection.connection_id
  const startButton = h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedRevoke({ connectionId: connection.connection_id })),
      h.Class(`${BUTTON_SECONDARY} self-start`),
    ],
    ['Revoke'],
  )
  return Revoke.match<ReadonlyArray<Html>>(revoke, {
    Idle: () => [startButton],
    Confirming: ({ connectionId }) =>
      isThis(connectionId)
        ? [
            h.div(
              [
                h.Role('group'),
                h.AriaLabel(`Confirm revoking ${connection.client_name}`),
                h.Class('flex flex-col gap-3'),
              ],
              [
                h.p(
                  [h.Class('text-sm text-ink')],
                  [
                    `Revoke ${connection.client_name}? The service stops signing for it immediately, and its onchain rule is removed.`,
                  ],
                ),
                h.div(
                  [h.Class('flex flex-wrap gap-2')],
                  [
                    h.button(
                      [
                        h.Type('button'),
                        h.OnClick(Message.ClickedConfirmRevoke({ connectionId })),
                        h.Class(BUTTON_DANGER),
                      ],
                      ['Revoke now'],
                    ),
                    h.button(
                      [h.Type('button'), h.OnClick(Message.ClickedCancelRevoke()), h.Class(BUTTON_SECONDARY)],
                      ['Keep it'],
                    ),
                  ],
                ),
              ],
            ),
          ]
        : [startButton],
    Revoking: ({ connectionId }) =>
      isThis(connectionId)
        ? [h.p([h.AriaLive('polite'), h.Class('text-sm text-muted')], ['Revoking…'])]
        : [startButton],
    Failed: ({ connectionId, error }) => (isThis(connectionId) ? [errorRow(error, h), startButton] : [startButton]),
  })
}

const connectionCard = (connection: GrantView, revoke: Revoke, h: HtmlBuilder<Message>): Html => {
  const isActive = connection.connection_status === 'active'
  return h.keyed('li')(
    connection.connection_id,
    [h.Class('flex flex-col gap-4 rounded-3xl border border-line bg-paper p-5 sm:p-6')],
    [
      h.div(
        [h.Class('flex flex-wrap items-start justify-between gap-3')],
        [
          h.div(
            [h.Class('flex flex-col gap-1')],
            [
              h.h2([h.Class('text-lg font-semibold text-ink')], [connection.client_name]),
              h.p(
                [h.Class('text-sm text-muted')],
                [
                  Option.match(Option.fromNullishOr(connection.client_domain), {
                    onNone: () => `Connected ${dateTime(connection.created_at)}`,
                    onSome: domain => `Published by ${domain} · connected ${dateTime(connection.created_at)}`,
                  }),
                ],
              ),
            ],
          ),
          isActive ? badge('Active', 'good', h) : badge('Revoked', 'quiet', h),
        ],
      ),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.div(
            [h.Class('flex items-baseline justify-between gap-4')],
            [
              h.span(
                [h.Class(`text-2xl font-semibold tabular-nums ${isActive ? 'text-accent' : 'text-muted'}`)],
                [`${usdc(connection.remaining)} left`],
              ),
              h.span([h.Class('text-sm tabular-nums text-muted')], [`of ${usdc(connection.total)}`]),
            ],
          ),
          meter(percentUsed(connection.total, connection.remaining), `${connection.client_name} allowance used`, h),
          h.p(
            [h.Class('text-sm text-muted')],
            [
              [
                Option.match(Option.fromNullishOr(connection.valid_until), {
                  onNone: () => 'No expiry set',
                  onSome: until => (isActive ? `Until ${dateTime(until)}` : `Was valid until ${dateTime(until)}`),
                }),
                ruleLabel(connection),
                ...Option.match(Option.fromNullishOr(connection.revoked_at), {
                  onNone: () => [],
                  onSome: at => [`revoked ${dateTime(at)}`],
                }),
              ].join(' · '),
            ],
          ),
        ],
      ),
      ...(isActive ? revokeControls(connection, revoke, h) : []),
    ],
  )
}

const ruleRemovalNotice = (url: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('status'),
      h.Class(
        'flex flex-col gap-3 rounded-3xl border border-warn/30 bg-warn/8 p-5 sm:flex-row sm:items-center sm:justify-between',
      ),
    ],
    [
      h.p([h.Class('text-sm text-ink')], ['The connection is off. Removing its onchain rule needs your passkey.']),
      h.a([h.Href(url), h.Class(`${BUTTON_PRIMARY} shrink-0`)], ['Remove the rule']),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      pageHeader(
        'Connections',
        'Each AI client you connect gets its own allowance and expiry. Revoke one and its next payment is refused.',
        h,
      ),
      ...Option.match(model.maybeRuleRemovalUrl, {
        onNone: () => [],
        onSome: url => [ruleRemovalNotice(url, h)],
      }),
      AsyncData.matchData(model.connections, {
        onEmpty: () => loadingRow(h),
        onFailure: error => errorRow(error, h),
        onData: connections =>
          Array.match(connections, {
            onEmpty: () =>
              emptyRow('No connections yet. Add this wallet as a connector in Claude to create the first one.', h),
            onNonEmpty: list =>
              h.ul(
                [h.Class('flex flex-col gap-4')],
                Array.map(list, connection => connectionCard(connection, model.revoke, h)),
              ),
          }),
      }),
    ],
  ),
)
