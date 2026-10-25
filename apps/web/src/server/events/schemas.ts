import { DateTime, Option, Schema } from 'effect'

/**
 * The wire of MCP Events (draft SEP-3415) as Nod serves it, ported from myapps `packages/mcp/src/events/schemas.ts`
 * (the profile Goblin consumes): bounded names, cursors and pages, the four methods' params and results, and the
 * webhook envelopes (an occurrence, or a `verification` / `gap` / `terminated` control).
 */
export const EVENT_LIMITS = {
  defaultTtlMs: 3_600_000,
  minTtlMs: 300_000,
  maxTtlMs: 86_400_000,
  /** Live subscriptions per connection. */
  subscriptions: 32,
  pageEvents: 100,
  bodyBytes: 262_144,
  timeoutMs: 5_000,
  attempts: 5,
  retryWindowMs: 900_000,
  rotationGraceMs: 300_000,
  sourceRetentionMs: 604_800_000,
  /** How often a poller is asked to come back. */
  nextPollMs: 10_000,
} as const

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
export const EventId = text(256)
export const EventName = text(128)
export const EventCursor = Schema.NullOr(text(2_048))
const milliseconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const isoTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u),
  Schema.makeFilter(value => Option.isSome(DateTime.make(value))),
)

export const EventSelector = Schema.Struct({ name: EventName, arguments: Schema.JsonObject })
export type EventSelector = typeof EventSelector.Type

export interface EventDescriptor {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Schema.JsonObject
  readonly payloadSchema: Schema.JsonObject
  readonly delivery: ReadonlyArray<'poll' | 'webhook'>
}

export const EventOccurrence = Schema.Struct({
  eventId: EventId,
  name: EventName,
  timestamp: isoTime,
  data: Schema.JsonObject,
  cursor: Schema.optional(EventCursor),
  _meta: Schema.optional(Schema.JsonObject),
})
export type EventOccurrence = typeof EventOccurrence.Type

export const EventListParams = Schema.Struct({
  cursor: Schema.optional(text(2_048)),
  _meta: Schema.optional(Schema.JsonObject),
})

const replay = { cursor: Schema.optional(EventCursor), maxAgeMs: Schema.optional(milliseconds) }
export const EventPollParams = Schema.Struct({
  ...EventSelector.fields,
  ...replay,
  maxEvents: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVENT_LIMITS.pageEvents }))),
  _meta: Schema.optional(Schema.JsonObject),
})
export type EventPollParams = typeof EventPollParams.Type

export const EventSubscribeParams = Schema.Struct({
  ...EventSelector.fields,
  ...replay,
  delivery: Schema.Struct({ mode: Schema.Literal('webhook'), url: text(4_096), secret: text(128) }),
  ttlMs: Schema.optional(Schema.NullOr(milliseconds)),
  _meta: Schema.optional(Schema.JsonObject),
})
export type EventSubscribeParams = typeof EventSubscribeParams.Type

export const EventUnsubscribeParams = Schema.Struct({
  ...EventSelector.fields,
  delivery: Schema.Struct({ mode: Schema.Literal('webhook'), url: text(4_096) }),
  _meta: Schema.optional(Schema.JsonObject),
})
export type EventUnsubscribeParams = typeof EventUnsubscribeParams.Type

export const EventCallbackReason = Schema.Literals([
  'connection_refused',
  'timeout',
  'tls_error',
  'http_4xx',
  'http_5xx',
  'challenge_failed',
])
export type EventCallbackReason = typeof EventCallbackReason.Type

export const EventWireError = Schema.Struct({
  code: Schema.Literals([-32602, -32011, -32012, -32013, -32014, -32015]),
  message: text(256),
  data: Schema.optional(Schema.JsonObject),
})
export const EventVerification = Schema.Struct({ type: Schema.Literal('verification'), challenge: text(256) })
export const EventGap = Schema.Struct({ type: Schema.Literal('gap'), cursor: EventCursor })
export const EventTerminated = Schema.Struct({ type: Schema.Literal('terminated'), error: EventWireError })
export const EventControl = Schema.Union([EventVerification, EventGap, EventTerminated])
export type EventControl = typeof EventControl.Type
export const EventEnvelope = Schema.Union([EventControl, EventOccurrence])
export type EventEnvelope = typeof EventEnvelope.Type
