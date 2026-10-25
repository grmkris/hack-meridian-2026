import { Clock, DateTime, Effect, Exit, Option, Schema } from 'effect'

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { McpError, type ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'

import { first, sql } from '../rows.ts'
import type { AppRuntime } from '../runtime.ts'
import type { ToolContext } from '../tools.ts'
import { WalletSettings } from '../wallet-settings.ts'
import { EVENT_DESCRIPTORS, eventArguments, eventDefinition, matchesArguments } from './catalog.ts'
import { eventChallengeMatches, postEventWebhook } from './delivery.ts'
import { eventProtocolError, McpEventError } from './errors.ts'
import { EventsHost } from './host.ts'
import { decodeEventCursor, eventCursor } from './journal.ts'
import { canonicalEventJson, eventCallbackUrl, eventSecret, eventSubscriptionId, eventTtlMs } from './policy.ts'
import {
  EVENT_LIMITS,
  EventListParams,
  type EventOccurrence,
  EventPollParams,
  EventSubscribeParams,
  EventUnsubscribeParams,
} from './schemas.ts'
import { sealEventSecret } from './secrets.ts'
import {
  activateSubscription,
  failVerification,
  journalAfter,
  journalHead,
  type JournalRow,
  liveSubscriptionCount,
  removeSubscription,
  subscriptionById,
  upsertSubscription,
} from './store.ts'

/**
 * MCP Events (draft SEP-3415, `io.modelcontextprotocol/events`) on today's protocol: `events/list`, `events/poll`,
 * `events/subscribe` (webhook, verified in the request), `events/unsubscribe`; `events/stream` is unsupported. The
 * principal is the OAuth connection (ctx.props); a revoked one is refused. Events are wallet-wide: every connection
 * of the wallet sees all of its events. `handleEventsRequest` is the plain entry both MCP lanes call.
 */

/** Declared on initialize (SDK 1 returns capabilities as given) and in server/discover. */
export const eventsCapabilities = {
  events: {},
  extensions: { 'io.modelcontextprotocol/events': {} },
} satisfies ServerCapabilities & { readonly events: Record<string, never> }

const decode = <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input ?? {}, { onExcessProperty: 'error' }).pipe(
    Effect.mapError(() => new McpEventError({ reason: 'invalid_params' })),
  )

/** The connection asking, while it is live. */
const principal = Effect.fnUntraced(function* (ctx: ToolContext) {
  const connection = yield* first(
    sql('SELECT status, wallet_id FROM connections WHERE id = ?', ctx.props.connection_id),
    row => Effect.succeed({ status: String(row['status']), walletId: String(row['wallet_id']) }),
  )
  if (connection?.status !== 'active' || connection.walletId !== ctx.props.wallet_id)
    return yield* new McpEventError({ reason: 'forbidden', data: { reason: 'connection revoked' } })
  return { connectionId: ctx.props.connection_id, walletId: ctx.props.wallet_id }
})

/** A path of Nod's own (`/approve/…`) on this origin; absolute links stay. */
export const resolveEventUrl = (data: Schema.JsonObject, origin: string): Schema.JsonObject => {
  const url = data['url']
  if (typeof url !== 'string' || !url.startsWith('/')) return data
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, key === 'url' ? `${origin}${url}` : value]),
  )
}

export const occurrenceOf = (row: JournalRow, origin: string): EventOccurrence => ({
  eventId: row.eventId,
  name: row.name,
  timestamp: row.occurredAt,
  data: resolveEventUrl(row.data, origin),
  cursor: eventCursor(row.seq),
})

/** Rows scanned per page before matching arguments. */
const SCAN = 500

/** One page of a wallet's events of `name` matching `args`, after `from` (≤ head). */
export const eventPage = Effect.fnUntraced(function* (input: {
  readonly walletId: string
  readonly name: string
  readonly args: Schema.JsonObject
  readonly from: number
  readonly head: number
  readonly maxEvents: number
  readonly cutoffIso: string | null
}) {
  const rows = yield* journalAfter(input.walletId, input.name, input.from, input.head, SCAN + 1)
  const scanned = rows.slice(0, SCAN)
  const matched: Array<JournalRow> = []
  let skippedOld = false
  let last = input.from
  for (const row of scanned) {
    if (matched.length === input.maxEvents) break
    last = row.seq
    if (input.cutoffIso !== null && row.occurredAt < input.cutoffIso) {
      skippedOld = true
      continue
    }
    if (matchesArguments(input.name, input.args, row.data)) matched.push(row)
  }
  const stoppedEarly = matched.length === input.maxEvents && scanned.some(row => row.seq > last)
  const hasMore = stoppedEarly || rows.length > SCAN
  return { rows: matched, cursor: hasMore ? last : input.head, hasMore, skippedOld }
})

const list = Effect.fnUntraced(function* (ctx: ToolContext, params: unknown) {
  yield* principal(ctx)
  yield* decode(EventListParams, params)
  return { events: EVENT_DESCRIPTORS }
})

const poll = Effect.fnUntraced(function* (ctx: ToolContext, params: unknown) {
  const { walletId } = yield* principal(ctx)
  const input = yield* decode(EventPollParams, params)
  const name = yield* eventDefinition(input.name)
  yield* eventArguments(name, input.arguments)
  const { head, pruned } = yield* journalHead
  if (input.cursor === null || input.cursor === undefined)
    return {
      events: [],
      cursor: eventCursor(head),
      truncated: false,
      hasMore: false,
      nextPollMs: EVENT_LIMITS.nextPollMs,
    }
  const cursor = input.cursor
  const from = yield* Effect.try({
    try: () => decodeEventCursor(cursor, head),
    catch: () => new McpEventError({ reason: 'invalid_params', data: { field: 'cursor' } }),
  })
  const nowMs = yield* Clock.currentTimeMillis
  const cutoffIso =
    input.maxAgeMs === undefined
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(nowMs - Math.min(input.maxAgeMs, EVENT_LIMITS.sourceRetentionMs)))
  const page = yield* eventPage({
    walletId,
    name,
    args: input.arguments,
    from,
    head,
    maxEvents: input.maxEvents ?? EVENT_LIMITS.pageEvents,
    cutoffIso,
  })
  return {
    events: page.rows.map(row => occurrenceOf(row, ctx.origin)),
    cursor: eventCursor(page.cursor),
    truncated: from < pruned || page.skippedOld,
    hasMore: page.hasMore,
    nextPollMs: page.hasMore ? 0 : EVENT_LIMITS.nextPollMs,
  }
})

const isLocalStage = WalletSettings.useSync(settings => settings.stage === 'local')

/** Prove the endpoint: a signed `verification` with a fresh challenge, answered by echoing it. */
const verifyEndpoint = Effect.fnUntraced(function* (input: {
  readonly id: string
  readonly url: string
  readonly local: boolean
  readonly secret: string
}) {
  const challenge = yield* Effect.sync(() =>
    [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join(''),
  )
  const result = yield* postEventWebhook({
    url: input.url,
    local: input.local,
    webhookId: `msg_verification_${challenge.slice(0, 16)}`,
    subscriptionId: input.id,
    body: JSON.stringify({ type: 'verification', challenge }),
    secrets: { current: input.secret },
  })
  if (!result.ok) return result.reason
  return eventChallengeMatches(result.body, challenge) ? undefined : ('challenge_failed' as const)
})

const subscribe = Effect.fnUntraced(function* (ctx: ToolContext, params: unknown) {
  const { connectionId, walletId } = yield* principal(ctx)
  const input = yield* decode(EventSubscribeParams, params)
  const name = yield* eventDefinition(input.name)
  yield* eventArguments(name, input.arguments)
  const local = yield* isLocalStage
  const url = yield* Effect.try({
    try: () => eventCallbackUrl(input.delivery.url, local),
    catch: () => new McpEventError({ reason: 'invalid_params', data: { field: 'delivery.url' } }),
  })
  yield* Effect.try({
    try: () => eventSecret(input.delivery.secret),
    catch: () => new McpEventError({ reason: 'invalid_params', data: { field: 'delivery.secret' } }),
  })
  const id = yield* Effect.promise(() => eventSubscriptionId(connectionId, { name, arguments: input.arguments }, url))
  const nowMs = yield* Clock.currentTimeMillis
  if ((yield* liveSubscriptionCount(connectionId, id, nowMs)) >= EVENT_LIMITS.subscriptions)
    return yield* new McpEventError({
      reason: 'quota',
      data: { limit: 'subscriptions', max: EVENT_LIMITS.subscriptions },
    })
  const { head, pruned } = yield* journalHead
  const requested = input.cursor
  const start =
    requested === null || requested === undefined
      ? head
      : yield* Effect.try({
          try: () => decodeEventCursor(requested, head),
          catch: () => new McpEventError({ reason: 'invalid_params', data: { field: 'cursor' } }),
        })
  const host = yield* EventsHost
  const sealedSecret = yield* sealEventSecret(host.vaultKey, input.delivery.secret, id)
  const expiresAt = nowMs + eventTtlMs(input.ttlMs)
  yield* upsertSubscription(
    {
      id,
      connectionId,
      walletId,
      name,
      argumentsJson: canonicalEventJson(input.arguments),
      url,
      origin: ctx.origin,
      sealedSecret,
      expiresAt,
      cursor: start,
      nowMs,
    },
    EVENT_LIMITS.rotationGraceMs,
  )
  const saved = yield* subscriptionById(id)
  if (saved?.connectionId !== connectionId) return yield* new McpEventError({ reason: 'forbidden' })
  const failure = yield* verifyEndpoint({ id, url, local, secret: input.delivery.secret })
  if (failure !== undefined) {
    yield* failVerification(id, sealedSecret, failure, nowMs)
    return yield* new McpEventError({ reason: 'callback', data: { reason: failure } })
  }
  yield* activateSubscription(id, sealedSecret, yield* Clock.currentTimeMillis)
  yield* host.poke(walletId)
  return {
    id,
    refreshBefore: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
    cursor: eventCursor(saved.cursor),
    truncated: saved.cursor < pruned,
  }
})

const unsubscribe = Effect.fnUntraced(function* (ctx: ToolContext, params: unknown) {
  const { connectionId } = yield* principal(ctx)
  const input = yield* decode(EventUnsubscribeParams, params)
  const local = yield* isLocalStage
  const url = yield* Effect.try({
    try: () => eventCallbackUrl(input.delivery.url, local),
    catch: () => new McpEventError({ reason: 'invalid_params', data: { field: 'delivery.url' } }),
  })
  yield* removeSubscription(
    connectionId,
    input.name,
    canonicalEventJson(input.arguments),
    url,
    yield* Clock.currentTimeMillis,
  )
  return {}
})

/** One `events/*` request as an Effect: the result object, or a safe McpEventError. */
export const eventsMethod = (ctx: ToolContext, method: string, params: unknown) => {
  switch (method) {
    case 'events/list':
      return list(ctx, params)
    case 'events/poll':
      return poll(ctx, params)
    case 'events/subscribe':
      return subscribe(ctx, params)
    case 'events/unsubscribe':
      return unsubscribe(ctx, params)
    case 'events/stream':
      return Effect.fail(new McpEventError({ reason: 'unsupported', data: { feature: 'deliveryMode', value: 'push' } }))
    default:
      return Effect.fail(new McpEventError({ reason: 'method_not_found' }))
  }
}

/**
 * One `events/*` request for an MCP lane: the result, or a thrown McpError (numeric `code`, optional `data`); -32601
 * for a method that is not an events method. Storage failures are -32603.
 */
export const handleEventsRequest = async (
  runtime: AppRuntime,
  ctx: ToolContext,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> => {
  const exit = await runtime.runPromiseExit(
    eventsMethod(ctx, method, params).pipe(Effect.map((result): Record<string, unknown> => ({ ...result }))),
  )
  if (Exit.isSuccess(exit)) return exit.value
  const error = Exit.findErrorOption(exit)
  if (Option.isSome(error) && error.value instanceof McpEventError) throw eventProtocolError(error.value)
  throw new McpError(-32603, 'Internal error')
}

/** The legacy (SDK 1) lane: every method without its own handler comes here; events/* are answered, the rest -32601. */
export const registerEvents = (server: Server, runtime: AppRuntime, ctx: ToolContext): void => {
  server.fallbackRequestHandler = async request => handleEventsRequest(runtime, ctx, request.method, request.params)
}
