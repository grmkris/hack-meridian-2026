import { Clock, Context, Effect, Schema } from 'effect'

import { McpEventError } from './errors.ts'
import { eventBodyBytes, eventCallbackUrl } from './policy.ts'
import { EVENT_LIMITS, type EventCallbackReason } from './schemas.ts'
import { type EventSigningSecrets, signEventWebhook } from './webhooks.ts'

/**
 * One signed webhook POST and what to do after it (ported from myapps `packages/mcp/src/events/delivery.ts`): the URL
 * rule again on every attempt, a fresh timestamp, 5 s, never a redirect, a bounded response; retry 15 s·2ⁿ (≤ 300 s,
 * jittered), abandoned after 5 attempts or 15 minutes, at once on 410, 413 or a redirect.
 */

/** The outbound HTTP of Events (verification challenges and deliveries); tests swap it for a stub. */
export interface EventEgressShape {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
}
export const EventEgress = Context.Reference<EventEgressShape>('hm/EventEgress', {
  defaultValue: () => ({ fetch: (url, init) => globalThis.fetch(url, init) }),
})

export interface EventPost {
  readonly url: string
  /** Allow http and local names (STAGE=local). */
  readonly local: boolean
  readonly webhookId: string
  readonly subscriptionId: string
  readonly body: string
  readonly secrets: EventSigningSecrets
}

export type EventPostResult =
  | { readonly ok: true; readonly status: number; readonly body: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly status?: number; readonly reason: EventCallbackReason }

const readBounded = async (response: Response): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > EVENT_LIMITS.bodyBytes) return undefined
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.byteLength > EVENT_LIMITS.bodyBytes ? undefined : bytes
}

/** POST one envelope. Never fails: a refused URL, a timeout or a network error is a callback reason. */
export const postEventWebhook = Effect.fnUntraced(function* (post: EventPost) {
  const egress = yield* EventEgress
  const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000)
  const prepared = yield* Effect.tryPromise({
    try: async () => {
      const url = eventCallbackUrl(post.url, post.local)
      const body = eventBodyBytes(post.body)
      const headers = await signEventWebhook({
        id: post.webhookId,
        subscriptionId: post.subscriptionId,
        body,
        timestamp: nowSeconds,
        secrets: post.secrets,
      })
      return { url, body, headers }
    },
    catch: () => new McpEventError({ reason: 'invalid_params' }),
  }).pipe(Effect.option)
  if (prepared._tag === 'None') return { ok: false, reason: 'http_4xx' } satisfies EventPostResult
  const { url, body, headers } = prepared.value
  return yield* Effect.tryPromise({
    try: async (signal): Promise<EventPostResult> => {
      const response = await egress.fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal })
      const bytes = await readBounded(response)
      if (response.status >= 200 && response.status < 300)
        return bytes === undefined
          ? { ok: false, status: response.status, reason: 'challenge_failed' }
          : { ok: true, status: response.status, body: bytes }
      return { ok: false, status: response.status, reason: response.status >= 500 ? 'http_5xx' : 'http_4xx' }
    },
    catch: () => 'connection_refused' as const,
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${EVENT_LIMITS.timeoutMs} millis`,
      orElse: () => Effect.fail('timeout' as const),
    }),
    Effect.catch(reason => Effect.succeed<EventPostResult>({ ok: false, reason })),
  )
})

export type EventDeliveryOutcome =
  | { readonly state: 'accepted'; readonly atMs: number }
  | { readonly state: 'retry'; readonly atMs: number; readonly reason: EventCallbackReason }
  | { readonly state: 'abandoned'; readonly atMs: number; readonly reason: EventCallbackReason }

/** After attempt number `attempts` (1-based) of a delivery first tried at `firstAttemptMs`. */
export const eventRetryDecision = (input: {
  readonly status?: number | undefined
  readonly reason?: EventCallbackReason | undefined
  readonly attempts: number
  readonly firstAttemptMs: number
  readonly nowMs: number
  /** A value in [0,1]. */
  readonly jitter: number
}): EventDeliveryOutcome => {
  const { status, attempts, firstAttemptMs, nowMs } = input
  if (status !== undefined && status >= 200 && status < 300 && input.reason === undefined)
    return { state: 'accepted', atMs: nowMs }
  const reason = input.reason ?? (status !== undefined && status >= 500 ? 'http_5xx' : 'http_4xx')
  const deadline = firstAttemptMs + EVENT_LIMITS.retryWindowMs
  const delay =
    Math.min(300_000, 15_000 * 2 ** Math.min(attempts - 1, 4)) * (0.75 + Math.max(0, Math.min(input.jitter, 1)) * 0.5)
  const atMs = Math.ceil(nowMs + delay)
  if (
    status === 410 ||
    status === 413 ||
    (status !== undefined && status >= 300 && status < 400) ||
    attempts >= EVENT_LIMITS.attempts ||
    nowMs >= deadline ||
    atMs >= deadline
  )
    return { state: 'abandoned', atMs: nowMs, reason }
  return { state: 'retry', atMs, reason }
}

/** The challenge echoed as `{ "challenge": … }`, compared without an early exit on its content. */
export const eventChallengeMatches = (body: Uint8Array<ArrayBuffer>, challenge: string): boolean => {
  if (body.byteLength > EVENT_LIMITS.bodyBytes) return false
  let echo: string
  try {
    echo = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }))(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)),
    ).challenge
  } catch {
    return false
  }
  const left = new TextEncoder().encode(echo)
  const right = new TextEncoder().encode(challenge)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}
