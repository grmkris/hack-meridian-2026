import { Array, Clock, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { Backend, type GrantView, Overview, type PendingApproval, type Resources } from '../backend'
import { allowanceHelp, allowanceState, clientUrl } from '../connection'
import { dateTime, shortAddress, usdc } from '../format'
import { Problem, recoverProblem } from '../problem'
import { connectionsRouter } from '../route'
import { disclosure } from '../view/disclosure'
import {
  BUTTON_NOD,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  FIGURE,
  LINK,
  emptyRow,
  errorRow,
  loadingRow,
  panel,
} from '../view/ui'

// MODEL
export const OverviewData = AsyncData.Schema(Overview, Schema.String)
export const SetupTarget = Schema.Literals(['Prompt', 'Url'])
export type SetupTarget = typeof SetupTarget.Type
export const SetupCopy = defineTaggedUnion({
  Idle: {},
  Copying: { target: SetupTarget },
  Copied: { target: SetupTarget },
  Failed: { target: SetupTarget },
})
export type SetupCopy = typeof SetupCopy.Type

export const setupSkillUrl = (connectorUrl: string): string => new URL('/skill/nod-guide/setup.md', connectorUrl).href
export const setupPrompt = (connectorUrl: string): string =>
  `Read ${setupSkillUrl(connectorUrl)} and follow its instructions to connect Nod.`

export const Model = Schema.Struct({
  overview: OverviewData.schema,
  maybeNowMs: Schema.Option(Schema.Finite),
  setupCopy: SetupCopy,
  setupOpen: Schema.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE
export const Message = defineMessageUnion({
  EnteredPage: {},
  ClickedRefresh: {},
  SucceededLoadOverview: { overview: Overview, nowMs: Schema.Finite },
  FailedLoadOverview: { problem: Problem },
  TickedTopupClock: { nowMs: Schema.Finite },
  ToggledSetup: { isOpen: Schema.Boolean },
  ClickedCopySetup: { target: SetupTarget, connectorUrl: Schema.String },
  CompletedCopySetup: { target: SetupTarget },
  FailedCopySetup: { target: SetupTarget },
})
export type Message = typeof Message.Type
export const OutMessage = defineMessageUnion({ EndedSession: {} })
export type OutMessage = typeof OutMessage.Type

export const init = (): Update.Return<Model, Message, Resources> => ({
  model: {
    overview: OverviewData.Idle(),
    maybeNowMs: Option.none(),
    setupCopy: SetupCopy.Idle(),
    setupOpen: false,
  },
})

// COMMAND
export const LoadOverview = Command.define('LoadOverview', {
  messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const overview = yield* backend.overview
    const nowMs = yield* Clock.currentTimeMillis
    return Message.SucceededLoadOverview({ overview, nowMs })
  }).pipe(recoverProblem(problem => Message.FailedLoadOverview({ problem }))),
})

export const CopySetup = Command.define('CopySetup', {
  args: { target: SetupTarget, connectorUrl: Schema.String },
  messages: [Message.CompletedCopySetup, Message.FailedCopySetup],
  execute: ({ target, connectorUrl }) =>
    Effect.tryPromise(() =>
      navigator.clipboard.writeText(target === 'Prompt' ? setupPrompt(connectorUrl) : connectorUrl),
    ).pipe(
      Effect.as(Message.CompletedCopySetup({ target })),
      Effect.orElseSucceed(() => Message.FailedCopySetup({ target })),
    ),
})

// UPDATE
export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const startLoad = (model: Model): UpdateReturn =>
  Option.match(AsyncData.revalidateOrLoad(model.overview), {
    onNone: () => ({ model }),
    onSome: nextOverview => ({
      model: modifyFields(model, { overview: () => nextOverview }),
      commands: [LoadOverview()],
    }),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () => startLoad(model),
    ClickedRefresh: () => startLoad(model),
    SucceededLoadOverview: ({ overview, nowMs }) => ({
      model: modifyFields(model, {
        overview: () => OverviewData.Success({ data: overview }),
        maybeNowMs: () => Option.some(nowMs),
      }),
    }),
    FailedLoadOverview: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({
          model: modifyFields(model, { overview: () => OverviewData.Idle() }),
          outMessage: OutMessage.EndedSession(),
        }),
        Failed: ({ error }) => ({ model: modifyFields(model, { overview: () => OverviewData.Failure({ error }) }) }),
      }),
    TickedTopupClock: ({ nowMs }) => ({ model: modifyFields(model, { maybeNowMs: () => Option.some(nowMs) }) }),
    ToggledSetup: ({ isOpen }) => ({ model: modifyFields(model, { setupOpen: () => isOpen }) }),
    ClickedCopySetup: ({ target, connectorUrl }) =>
      SetupCopy.guards.Copying(model.setupCopy)
        ? { model }
        : {
            model: modifyFields(model, { setupCopy: () => SetupCopy.Copying({ target }) }),
            commands: [CopySetup({ target, connectorUrl })],
          },
    CompletedCopySetup: ({ target }) => ({
      model: modifyFields(model, { setupCopy: () => SetupCopy.Copied({ target }) }),
    }),
    FailedCopySetup: ({ target }) => ({
      model: modifyFields(model, { setupCopy: () => SetupCopy.Failed({ target }) }),
    }),
  })

export const informEntered = (model: Model) => update(model, Message.EnteredPage())
export const informClock = (nowMs: number) => (model: Model) => update(model, Message.TickedTopupClock({ nowMs }))

// VIEW
const APP_MARKS = [
  { id: 'openai', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'grok', label: 'Grok' },
  { id: 'grokbot', label: 'Grok Bot' },
]

const setupArtifact = (target: SetupTarget, connectorUrl: string, copy: SetupCopy, h: HtmlBuilder<Message>): Html => {
  const isPrompt = target === 'Prompt'
  const label = isPrompt ? 'Setup prompt' : 'MCP URL'
  const value = isPrompt ? setupPrompt(connectorUrl) : connectorUrl
  const copied = SetupCopy.guards.Copied(copy) && copy.target === target
  const failed = SetupCopy.guards.Failed(copy) && copy.target === target
  return h.div(
    [h.Class('min-w-0 border-t border-line py-5')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-3')],
        [
          h.h3([h.Class('text-base font-medium')], [label]),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCopySetup({ target, connectorUrl })),
              h.Disabled(SetupCopy.guards.Copying(copy)),
              h.AriaLabel(isPrompt ? 'Copy setup prompt' : 'Copy MCP URL'),
              h.Class(BUTTON_SECONDARY),
            ],
            [copied ? 'Copied' : 'Copy'],
          ),
        ],
      ),
      h.p(
        [h.Class('mt-2 text-sm text-muted')],
        [
          isPrompt
            ? 'Paste into an agent that can add connectors for you.'
            : 'Paste into your app’s connector settings.',
        ],
      ),
      h.p([h.Class('mt-3 select-text text-sm leading-relaxed [overflow-wrap:anywhere]')], [value]),
      failed
        ? h.p(
            [h.Role('status'), h.Class('mt-2 text-sm text-danger')],
            ['Clipboard unavailable. Select the text above and copy it.'],
          )
        : h.empty,
    ],
  )
}

const setupView = (model: Model, connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('min-w-0')],
    [
      h.h2(
        [h.Class('font-display text-[clamp(1.5rem,4vw,2rem)] font-bold leading-tight tracking-[-0.025em]')],
        ['Use Nod in your chat.'],
      ),
      h.p([h.Class('mt-3 mb-5 text-sm text-muted')], ['Connect now. Add money whenever you’re ready.']),
      setupArtifact('Prompt', connectorUrl, model.setupCopy, h),
      setupArtifact('Url', connectorUrl, model.setupCopy, h),
      h.ul(
        [h.AriaLabel('AI apps'), h.Class('flex flex-wrap items-center gap-4 pt-1')],
        Array.map(APP_MARKS, app =>
          h.keyed('li')(
            app.id,
            [h.Title(app.label)],
            [h.img([h.Src(`/apps/${app.id}.svg`), h.Alt(app.label), h.Class('size-5 shrink-0 opacity-65')])],
          ),
        ),
      ),
      h.p(
        [h.Role('status'), h.AriaLive('polite'), h.Class('sr-only')],
        [
          SetupCopy.guards.Copied(model.setupCopy)
            ? `${model.setupCopy.target === 'Prompt' ? 'Setup prompt' : 'MCP URL'} copied.`
            : '',
        ],
      ),
    ],
  )

const allowanceRow = (grant: GrantView, model: Model, isSingle: boolean, h: HtmlBuilder<Message>): Html => {
  const state = allowanceState(grant, model.maybeNowMs)
  return h.keyed('li')(
    grant.connection_id,
    [h.Class('min-w-0 py-5 first:pt-0 last:pb-0')],
    [
      h.p([h.Class('text-sm font-medium [overflow-wrap:anywhere]')], [grant.client_name]),
      state === 'ready'
        ? h.div(
            [h.Class('mt-2')],
            [
              h.p(
                [h.Class('flex flex-wrap items-baseline gap-x-2 gap-y-1')],
                [
                  h.span(
                    [
                      h.Class(
                        `font-sans font-semibold tracking-[-0.025em] text-accent tabular-nums [overflow-wrap:anywhere] ${isSingle ? 'text-3xl' : 'text-xl'}`,
                      ),
                    ],
                    [usdc(grant.remaining)],
                  ),
                  h.span([h.Class('text-sm text-muted')], ['left to spend']),
                ],
              ),
              h.p(
                [h.Class('mt-2 text-sm text-muted [overflow-wrap:anywhere]')],
                [`of ${usdc(grant.total)}, until ${dateTime(grant.valid_until ?? '')}`],
              ),
            ],
          )
        : h.p([h.Class('mt-2 text-sm text-muted')], [allowanceHelp[state]]),
      Option.match(clientUrl(grant.client_domain), {
        onNone: () => h.p([h.Class('mt-3 text-sm text-muted')], [`Return to ${grant.client_name} to use Nod.`]),
        onSome: url =>
          h.a(
            [
              h.Href(url),
              h.Target('_blank'),
              h.Rel('noopener noreferrer'),
              h.Class(
                `${isSingle ? BUTTON_PRIMARY : LINK} mt-4 inline-flex min-h-11 items-center [overflow-wrap:anywhere]`,
              ),
            ],
            [`Open ${grant.client_name}`],
          ),
      }),
    ],
  )
}

const connectionView = (overview: Overview, model: Model, connectorUrl: string, h: HtmlBuilder<Message>): Html => {
  const connected = Array.filter(overview.grants, grant => grant.connection_status === 'active')
  return Array.match(connected, {
    onEmpty: () => setupView(model, connectorUrl, h),
    onNonEmpty: grants =>
      h.section(
        [h.Class('min-w-0'), h.AriaLabel('Connected apps')],
        [
          h.h2([h.Class('mb-5 font-display text-2xl font-bold tracking-[-0.025em]')], ['Continue in your chat.']),
          h.ul(
            [h.Class('divide-y divide-line')],
            Array.map(grants, grant => allowanceRow(grant, model, grants.length === 1, h)),
          ),
          h.p(
            [h.Class('mt-4 text-sm leading-relaxed text-muted')],
            [
              grants.length === 1
                ? 'Payments share this allowance. Spending above it needs your passkey.'
                : 'Each app has its own cumulative allowance. Spending above it needs your passkey.',
            ],
          ),
          h.a(
            [h.Href(connectionsRouter()), h.Class(`${LINK} mt-2 inline-flex min-h-11 items-center text-sm`)],
            ['Manage permissions'],
          ),
          h.div(
            [h.Class('mt-5 border-t border-line pt-3')],
            [
              disclosure(
                'connect-another',
                'Connect another app',
                model.setupOpen,
                isOpen => Message.ToggledSetup({ isOpen }),
                () => setupView(model, connectorUrl, h),
                h,
              ),
            ],
          ),
        ],
      ),
  })
}

const approvalRow = (approval: PendingApproval, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    approval.intent_id,
    [h.Class('flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between')],
    [
      h.div(
        [h.Class('flex min-w-0 flex-col gap-1')],
        [
          h.p(
            [h.Class('text-ink')],
            [
              h.span([h.Class(`${FIGURE} text-2xl`)], [usdc(approval.amount)]),
              ` to ${approval.recipient_name ?? shortAddress(approval.recipient_address)}`,
            ],
          ),
          h.p(
            [h.Class('text-sm text-muted')],
            [`Asked by ${approval.requester} · open until ${dateTime(approval.expires_at)}`],
          ),
          ...Option.match(Option.fromNullishOr(approval.reason), {
            onNone: () => [],
            onSome: reason => [
              h.p(
                [h.Class('border-l-2 border-line pl-3 text-sm text-muted [overflow-wrap:anywhere]')],
                [h.span([h.Class('italic text-ink')], [`“${reason}”`]), ` ${approval.requester}’s words`],
              ),
            ],
          }),
        ],
      ),
      h.a([h.Href(approval.approve_url), h.Class(`${BUTTON_NOD} shrink-0`)], ['Review and approve']),
    ],
  )

const approvalsPanel = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  panel(
    'Needs your nod',
    [
      Array.match(overview.pending, {
        onEmpty: () => emptyRow('Nothing is waiting. A payment past an allowance shows up here for your passkey.', h),
        onNonEmpty: pending =>
          h.ul(
            [h.Class('divide-y divide-line')],
            Array.map(pending, approval => approvalRow(approval, h)),
          ),
      }),
    ],
    h,
  )

type ViewInputs = Readonly<{ connectorUrl: string }>
const loadedView = (overview: Overview, model: Model, connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-8')],
    [
      h.div([h.Class('max-w-[600px] py-4')], [connectionView(overview, model, connectorUrl, h)]),
      ...Array.match(overview.pending, { onEmpty: () => [], onNonEmpty: () => [approvalsPanel(overview, h)] }),
    ],
  )
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { connectorUrl }, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      h.h1([h.Class('sr-only')], ['Wallet']),
      AsyncData.matchData(model.overview, {
        onEmpty: () => loadingRow(h),
        onFailure: error =>
          h.div(
            [h.Class('flex flex-col items-start gap-4')],
            [
              errorRow(error, h),
              h.button(
                [h.Type('button'), h.OnClick(Message.ClickedRefresh()), h.Class(BUTTON_SECONDARY)],
                ['Try again'],
              ),
            ],
          ),
        onData: overview => loadedView(overview, model, connectorUrl, h),
      }),
    ],
  ),
)
