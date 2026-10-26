import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, GrantView, LinkView, type Resources, RevokeReply } from '../backend'
import { allowanceHelp, allowanceState } from '../connection'
import { dateTime, isMainnet, percentUsed, shortAddress, usdc } from '../format'
import { Problem, recoverProblem } from '../problem'
import { homeRouter } from '../route'
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  FIGURE,
  LINK,
  badge,
  emptyRow,
  errorRow,
  loadingRow,
  meter,
  pageHeader,
  panel,
} from '../view/ui'

// MODEL

export const ConnectionsData = AsyncData.Schema(Schema.Array(GrantView), Schema.String)
/** Person links: an allowance for one person (the sender's passkey set it for exactly the amount, seven days). */
export const LinksData = AsyncData.Schema(Schema.Array(LinkView), Schema.String)
type LinksData = typeof LinksData.schema.Type

export const Revoke = defineTaggedUnion({
  Idle: {},
  Confirming: { connectionId: Schema.String },
  Revoking: { connectionId: Schema.String },
  Failed: { connectionId: Schema.String, error: Schema.String },
})
export type Revoke = typeof Revoke.Type

export const Model = Schema.Struct({
  connections: ConnectionsData.schema,
  links: LinksData.schema,
  revoke: Revoke,
  maybeRuleRemovalUrl: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  EnteredPage: {},
  SucceededLoadConnections: { connections: Schema.Array(GrantView) },
  FailedLoadConnections: { problem: Problem },
  SucceededLoadLinks: { links: Schema.Array(LinkView) },
  FailedLoadLinks: { problem: Problem },
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
  model: {
    connections: ConnectionsData.Idle(),
    links: LinksData.Idle(),
    revoke: Revoke.Idle(),
    maybeRuleRemovalUrl: Option.none(),
  },
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

export const LoadLinks = Command.define('LoadLinks', {
  messages: [Message.SucceededLoadLinks, Message.FailedLoadLinks],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const links = yield* backend.links
    return Message.SucceededLoadLinks({ links })
  }).pipe(recoverProblem(problem => Message.FailedLoadLinks({ problem }))),
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
  model: modifyFields(model, {
    connections: () => ConnectionsData.Idle(),
    links: () => LinksData.Idle(),
    revoke: () => Revoke.Idle(),
  }),
  outMessage: OutMessage.EndedSession(),
})

const replaceConnection =
  (next: GrantView) =>
  (connections: ReadonlyArray<GrantView>): ReadonlyArray<GrantView> =>
    Array.map(connections, connection => (connection.connection_id === next.connection_id ? next : connection))

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () => {
      const maybeConnections = AsyncData.revalidateOrLoad(model.connections)
      const maybeLinks = AsyncData.revalidateOrLoad(model.links)
      return {
        model: modifyFields(model, {
          connections: connections => Option.getOrElse(maybeConnections, () => connections),
          links: links => Option.getOrElse(maybeLinks, () => links),
        }),
        commands: [
          ...Option.match(maybeConnections, { onNone: () => [], onSome: () => [LoadConnections()] }),
          ...Option.match(maybeLinks, { onNone: () => [], onSome: () => [LoadLinks()] }),
        ],
      }
    },
    SucceededLoadLinks: ({ links }) => ({
      model: modifyFields(model, { links: () => LinksData.Success({ data: links }) }),
    }),
    FailedLoadLinks: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => endSession(model),
        Failed: ({ error }) => ({ model: modifyFields(model, { links: () => LinksData.Failure({ error }) }) }),
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
    onNone: () => 'Not on your Stellar account yet',
    onSome: status =>
      ({
        installed: 'On your Stellar account',
        removal_pending: 'Still on your Stellar account until your passkey removes it',
        removed: 'Removed from your Stellar account',
      })[status],
  })

const revokeSteps = (clientName: string, stopped: boolean, removed: boolean, h: HtmlBuilder<Message>): Html =>
  h.ol(
    [h.Class('flex flex-col gap-2 text-sm text-ink')],
    [
      revokeStep(
        1,
        stopped,
        [
          h.span([h.Class('font-semibold')], [`Nod stops signing for ${clientName}`]),
          ' at once and sweeps its pocket back to your wallet.',
        ],
        h,
      ),
      revokeStep(
        2,
        removed,
        [h.span([h.Class('font-semibold')], ['One passkey tap removes the allowance']), ' from your Stellar account.'],
        h,
      ),
    ],
  )

const revokeStep = (number: number, done: boolean, text: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Class('flex items-start gap-3')],
    [
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            `grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${done ? 'bg-good text-paper' : 'bg-paper text-ink ring-1 ring-line'}`,
          ),
        ],
        [done ? '✓' : String(number)],
      ),
      h.span([h.Class('min-w-0 pt-0.5')], [...text, ...(done ? [h.span([h.Class('sr-only')], [' Done.'])] : [])]),
    ],
  )

const revokeControls = (connection: GrantView, revoke: Revoke, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const isThis = (connectionId: string) => connectionId === connection.connection_id
  const startButton = h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedRevoke({ connectionId: connection.connection_id })),
      h.DataAttribute('testid', 'revoke'),
      h.DataAttribute('connection', connection.connection_id),
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
                h.Class('flex flex-col gap-4 rounded-2xl bg-mist p-4'),
              ],
              [
                h.p([h.Class('text-sm font-semibold text-ink')], [`Revoke ${connection.client_name} in two steps:`]),
                revokeSteps(connection.client_name, false, false, h),
                h.div(
                  [h.Class('flex flex-wrap gap-2')],
                  [
                    h.button(
                      [
                        h.Type('button'),
                        h.OnClick(Message.ClickedConfirmRevoke({ connectionId })),
                        h.DataAttribute('testid', 'revoke-confirm'),
                        h.DataAttribute('connection', connectionId),
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
        ? [h.p([h.AriaLive('polite'), h.Class('text-sm text-muted')], ['Stopping and sweeping the pocket…'])]
        : [startButton],
    Failed: ({ connectionId, error }) => (isThis(connectionId) ? [errorRow(error, h), startButton] : [startButton]),
  })
}

/** The Worker's own page (outside this app's routes) where the passkey removes a revoked app's allowance. */
const ruleRemovalHref = (connectionId: string): string => Array.join(['', 'approve', 'revoke', connectionId], '/')

/** A revoked AI app whose allowance is still on the account: the state between the two steps, and the way on. */
const ruleStillOnAccount = (connection: GrantView, showLink: boolean, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  connection.rule_status === 'removal_pending'
    ? [
        h.div(
          [h.Class('flex flex-col gap-3 rounded-2xl bg-nod-wash p-4')],
          [
            revokeSteps(connection.client_name, true, false, h),
            ...(showLink
              ? [
                  h.a(
                    [
                      h.Href(ruleRemovalHref(connection.connection_id)),
                      h.DataAttribute('connection', connection.connection_id),
                      h.Class(`${BUTTON_PRIMARY} self-start`),
                    ],
                    ['Remove the rule with your passkey'],
                  ),
                ]
              : []),
          ],
        ),
      ]
    : []

const validity = (connection: GrantView, isActive: boolean): string =>
  Option.match(Option.fromNullishOr(connection.valid_until), {
    onNone: () => 'No expiry set',
    onSome: until => (isActive ? `Until ${dateTime(until)}` : `Was valid until ${dateTime(until)}`),
  })

const activeAllowance = (connection: GrantView, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.p([h.Class('text-sm text-ink')], ['May still spend on its own']),
      h.p(
        [h.Class('flex flex-wrap items-baseline gap-x-2')],
        [
          h.span([h.Class(`${FIGURE} text-4xl leading-none text-accent`)], [usdc(connection.remaining)]),
          h.span([h.Class('text-sm tabular-nums text-muted')], [`of ${usdc(connection.total)}`]),
        ],
      ),
      meter(percentUsed(connection.total, connection.remaining), `${connection.client_name} allowance used`, h),
      h.p([h.Class('text-sm text-muted')], [`${validity(connection, true)}. ${ruleLabel(connection)}.`]),
      h.p([h.Class('text-sm text-ink')], ['Spending above the remaining allowance needs your passkey.']),
    ],
  )

const pastAllowance = (connection: GrantView, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-1 text-sm text-muted')],
    [
      h.p(
        [h.Class('tabular-nums text-ink')],
        [`Allowance ${usdc(connection.total)}, spent ${usdc(connection.spent)}.`],
      ),
      h.p(
        [],
        [
          [
            validity(connection, false),
            ...Option.match(Option.fromNullishOr(connection.revoked_at), {
              onNone: () => [],
              onSome: at => [`Revoked ${dateTime(at)}`],
            }),
            ruleLabel(connection),
          ].join('. ') + '.',
        ],
      ),
    ],
  )

const connectionCard = (
  connection: GrantView,
  revoke: Revoke,
  showRuleLink: boolean,
  nowMs: Option.Option<number>,
  h: HtmlBuilder<Message>,
): Html => {
  const isActive = connection.connection_status === 'active'
  const state = allowanceState(connection, nowMs)
  return h.keyed('li')(
    connection.connection_id,
    [
      h.Class('flex min-w-0 flex-col gap-4 border-t border-line py-6'),
      h.DataAttribute('connection', connection.connection_id),
      ...(isActive ? [] : [h.DataAttribute('testid', 'revoked')]),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-start justify-between gap-3')],
        [
          h.div(
            [h.Class('flex min-w-0 flex-col gap-1')],
            [
              h.h2(
                [h.Class('font-display text-xl font-bold text-ink [overflow-wrap:anywhere]')],
                [connection.client_name],
              ),
              h.p(
                [h.Class('text-sm text-muted [overflow-wrap:anywhere]')],
                [
                  Option.match(Option.fromNullishOr(connection.client_domain), {
                    onNone: () => `Connected ${dateTime(connection.created_at)}`,
                    onSome: domain => `Published by ${domain}, connected ${dateTime(connection.created_at)}`,
                  }),
                ],
              ),
            ],
          ),
          isActive ? badge('Active', 'good', h) : badge('Revoked', 'quiet', h),
        ],
      ),
      state === 'ready'
        ? activeAllowance(connection, h)
        : h.div(
            [h.Class('flex flex-col gap-2')],
            [h.p([h.Class('text-sm text-muted')], [allowanceHelp[state]]), pastAllowance(connection, h)],
          ),
      ...(isActive ? revokeControls(connection, revoke, h) : ruleStillOnAccount(connection, showRuleLink, h)),
    ],
  )
}

const ruleRemovalNotice = (url: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('status'),
      h.Class(
        'flex flex-col gap-3 rounded-3xl bg-nod-wash p-5 shadow-[0_0_0_1px_rgb(153_86_0/0.2)] sm:flex-row sm:items-center sm:justify-between',
      ),
    ],
    [
      h.p(
        [h.Class('text-sm text-ink')],
        [
          h.span([h.Class('font-semibold')], ['Nod has stopped signing for this AI app']),
          ' and swept its pocket back to your wallet. One passkey tap removes the rule from your Stellar account.',
        ],
      ),
      h.a(
        [h.Href(url), h.DataAttribute('testid', 'remove-rule'), h.Class(`${BUTTON_PRIMARY} shrink-0`)],
        ['Remove the rule'],
      ),
    ],
  )

const LINK_STATUS: Readonly<
  Record<LinkView['status'], Readonly<{ label: string; tone: 'accent' | 'good' | 'quiet' }>>
> = {
  open: { label: 'Open', tone: 'accent' },
  paid: { label: 'Paid', tone: 'good' },
  revoked: { label: 'Revoked', tone: 'quiet' },
  expired: { label: 'Expired', tone: 'quiet' },
}

/** stellar.expert for the wallet's network; the Worker sends links' hashes without a base. */
const explorerTxUrl = (network: string, hash: string): string =>
  `https://stellar.expert/explorer/${isMainnet(network) ? 'public' : 'testnet'}/tx/${hash}`

const linkWhen = (link: LinkView): string =>
  link.status === 'open'
    ? `Open until ${dateTime(link.expires_at)}`
    : Option.match(Option.fromNullishOr(link.paid_at), {
        onNone: () => `Was open until ${dateTime(link.expires_at)}`,
        onSome: paidAt => `Paid ${dateTime(paidAt)}`,
      })

const linkRow = (link: LinkView, network: string, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    link.id,
    [
      h.DataAttribute('testid', 'link-row'),
      h.DataAttribute('link', link.id),
      h.Class('flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between'),
    ],
    [
      h.div(
        [h.Class('flex min-w-0 flex-col gap-1')],
        [
          h.p(
            [h.Class('flex flex-wrap items-baseline gap-x-2 gap-y-1')],
            [
              h.span([h.Class('font-semibold text-ink [overflow-wrap:anywhere]')], [link.recipient_name]),
              h.span([h.Class(`${FIGURE} text-xl text-ink`)], [usdc(link.amount)]),
              badge(LINK_STATUS[link.status].label, LINK_STATUS[link.status].tone, h),
            ],
          ),
          h.p(
            [h.Class('flex flex-wrap items-center gap-x-2 text-sm text-muted')],
            [
              linkWhen(link),
              ...Option.match(Option.fromNullishOr(link.tx_hash), {
                onNone: () => [],
                onSome: hash => [
                  h.a(
                    [
                      h.Href(explorerTxUrl(network, hash)),
                      h.Target('_blank'),
                      h.Rel('noreferrer'),
                      h.Class(`${LINK} font-mono text-[0.8125rem]`),
                    ],
                    [`${shortAddress(hash)} ↗`],
                  ),
                ],
              }),
            ],
          ),
        ],
      ),
      ...Option.match(Option.fromNullishOr(link.status === 'open' ? link.revoke_url : null), {
        onNone: () => [],
        onSome: url => [
          h.a(
            [
              h.Href(url),
              h.DataAttribute('testid', 'link-revoke'),
              h.DataAttribute('link', link.id),
              h.Class(`${BUTTON_SECONDARY} shrink-0 self-start sm:self-center`),
            ],
            ['Revoke'],
          ),
        ],
      }),
    ],
  )

const linksPanel = (links: LinksData, network: string, h: HtmlBuilder<Message>): Html =>
  panel(
    'Links',
    [
      h.p(
        [h.Class('-mt-2 mb-4 text-sm text-muted')],
        ['A link is an allowance for one person: your passkey set it for exactly the amount, for seven days.'],
      ),
      AsyncData.matchData(links, {
        onEmpty: () => loadingRow(h),
        onFailure: error => errorRow(error, h),
        onData: list =>
          Array.match(list, {
            onEmpty: () => emptyRow('No links yet. When you send money to someone new, the link shows up here.', h),
            onNonEmpty: rows =>
              h.ul(
                [h.Class('divide-y divide-line')],
                Array.map(rows, link => linkRow(link, network, h)),
              ),
          }),
      }),
    ],
    h,
  )

/** The wallet's network, for explorer links the Worker sends as bare hashes. */
export type ViewInputs = Readonly<{ network: string; nowMs: Option.Option<number> }>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, viewInputs, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      pageHeader(
        'Connections',
        'Each AI app you connect has its own allowance and expiry. Revoke one and Nod stops paying for it at once.',
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
              h.p(
                [h.Class('py-5 text-sm text-muted')],
                ['No connected apps yet. ', h.a([h.Href(homeRouter()), h.Class(LINK)], ['Connect an app from Home.'])],
              ),
            onNonEmpty: list =>
              h.ul(
                [h.Class('flex flex-col gap-4')],
                Array.map(list, connection =>
                  connectionCard(
                    connection,
                    model.revoke,
                    Option.isNone(model.maybeRuleRemovalUrl),
                    viewInputs.nowMs,
                    h,
                  ),
                ),
              ),
          }),
      }),
      linksPanel(model.links, viewInputs.network, h),
    ],
  ),
)
