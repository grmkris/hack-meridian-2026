import { Predicate, Schema } from 'effect'

import { McpEventError } from './errors.ts'
import { eventSecret } from './policy.ts'
import { EVENT_LIMITS, EventControl, type EventEnvelope, EventOccurrence } from './schemas.ts'

/**
 * Standard Webhooks signing and verification (ported from myapps `packages/mcp/src/events/webhooks.ts`): HMAC-SHA256
 * over `<webhook-id>.<webhook-timestamp>.<body>`, `v1,<base64>`; during a secret rotation both the new and the
 * previous secret sign, for five minutes. Nod only signs; the verifier is what a subscriber (and the tests) run.
 */

export interface EventSigningSecrets {
  readonly current: string
  readonly previous?: { readonly secret: string; readonly expiresAtMs: number } | undefined
}
export interface EventWebhookInput {
  readonly id: string
  readonly subscriptionId: string
  readonly body: Uint8Array<ArrayBuffer>
  /** A fresh Unix timestamp (seconds) for this attempt, not the occurrence's. */
  readonly timestamp: number
  readonly secrets: EventSigningSecrets
}

const base64 = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const headerId = Schema.String.check(Schema.isPattern(/^[!-~]{1,256}$/u))
const signingKey = (secret: string) =>
  crypto.subtle.importKey('raw', eventSecret(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

const signedBytes = (id: string, timestamp: string, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`)
  const bytes = new Uint8Array(prefix.length + body.length)
  bytes.set(prefix)
  bytes.set(body, prefix.length)
  return bytes
}

const currentSecrets = (secrets: EventSigningSecrets, nowMs: number): ReadonlyArray<string> =>
  secrets.previous !== undefined && nowMs < secrets.previous.expiresAtMs
    ? [secrets.current, secrets.previous.secret]
    : [secrets.current]

const checkBody = (body: Uint8Array): void => {
  if (body.byteLength > EVENT_LIMITS.bodyBytes)
    throw new McpEventError({ reason: 'quota', data: { limit: 'bodyBytes', max: EVENT_LIMITS.bodyBytes } })
}

/** The headers of one signed POST; each retry signs again with its own timestamp. */
export const signEventWebhook = async (input: EventWebhookInput): Promise<Readonly<Record<string, string>>> => {
  checkBody(input.body)
  if (!Schema.is(headerId)(input.id) || !Schema.is(headerId)(input.subscriptionId))
    throw new McpEventError({ reason: 'invalid_params' })
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0)
    throw new McpEventError({ reason: 'invalid_params' })
  const timestamp = String(input.timestamp)
  const bytes = signedBytes(input.id, timestamp, input.body)
  const signatures = await Promise.all(
    currentSecrets(input.secrets, input.timestamp * 1_000).map(
      async secret => `v1,${base64(await crypto.subtle.sign('HMAC', await signingKey(secret), bytes))}`,
    ),
  )
  return {
    'content-type': 'application/json',
    'webhook-id': input.id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '),
    'X-MCP-Subscription-Id': input.subscriptionId,
  }
}

const signaturesOf = (raw: string): ReadonlyArray<Uint8Array<ArrayBuffer>> => {
  if (raw.length > 512) throw new McpEventError({ reason: 'invalid_params' })
  const entries = raw.split(' ')
  if (entries.length > 2) throw new McpEventError({ reason: 'invalid_params' })
  const signatures: Array<Uint8Array<ArrayBuffer>> = []
  for (const entry of entries) {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/u.test(entry)) continue
    signatures.push(Uint8Array.from(atob(entry.slice(3)), unit => unit.charCodeAt(0)))
  }
  return signatures
}

const decodeEnvelope = (body: Uint8Array<ArrayBuffer>, id: string): EventEnvelope => {
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body))
  // A type field always selects the control branch, even when invalid; it never falls back to an occurrence.
  if (Predicate.isObject(raw) && 'type' in raw) {
    const control = Schema.decodeUnknownSync(EventControl)(raw)
    if (!id.startsWith(`msg_${control.type}_`) || id.length === `msg_${control.type}_`.length)
      throw new McpEventError({ reason: 'invalid_params' })
    return control
  }
  const occurrence = Schema.decodeUnknownSync(EventOccurrence)(raw)
  if (occurrence.eventId !== id) throw new McpEventError({ reason: 'invalid_params' })
  return occurrence
}

/** Check the bounded raw bytes, freshness (±5 min) and the HMAC before any JSON parsing; the envelope. */
export const verifyEventWebhook = async (
  body: Uint8Array<ArrayBuffer>,
  headers: Headers,
  secrets: EventSigningSecrets,
  nowSeconds: number,
): Promise<EventEnvelope> => {
  checkBody(body)
  const id = headers.get('webhook-id') ?? ''
  const timestamp = headers.get('webhook-timestamp') ?? ''
  const signatures = signaturesOf(headers.get('webhook-signature') ?? '')
  if (
    !Schema.is(headerId)(id) ||
    !Schema.is(headerId)(headers.get('X-MCP-Subscription-Id')) ||
    !/^\d{1,16}$/u.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    !Number.isSafeInteger(nowSeconds) ||
    Math.abs(nowSeconds - Number(timestamp)) > EVENT_LIMITS.rotationGraceMs / 1_000
  )
    throw new McpEventError({ reason: 'forbidden' })
  const bytes = signedBytes(id, timestamp, body)
  const checks = await Promise.all(
    currentSecrets(secrets, nowSeconds * 1_000).flatMap(secret =>
      signatures.map(async signature => crypto.subtle.verify('HMAC', await signingKey(secret), signature, bytes)),
    ),
  )
  if (!checks.some(Boolean)) throw new McpEventError({ reason: 'forbidden' })
  try {
    return decodeEnvelope(body, id)
  } catch {
    throw new McpEventError({ reason: 'invalid_params' })
  }
}
