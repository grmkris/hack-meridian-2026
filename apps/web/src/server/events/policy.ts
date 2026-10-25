import { Predicate, type Schema } from 'effect'

import { McpEventError } from './errors.ts'
import { EVENT_LIMITS, type EventSelector } from './schemas.ts'

/** Callback, secret, TTL and identity rules (ported from myapps `packages/mcp/src/events/policy.ts`). */

const encoder = new TextEncoder()
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.invalid', '.test', '.example']

/**
 * A callback URL Nod will POST to, checked again on every attempt: https on the default port to a public DNS name, no
 * credentials, no fragment, already canonical. `local` (STAGE=local only) also admits http and local names, for a
 * subscriber on the same machine.
 */
export const eventCallbackUrl = (raw: string, local = false): string => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new McpEventError({ reason: 'invalid_params', data: { field: 'delivery.url' } })
  }
  const host = url.hostname
  const refused = local
    ? (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      raw.includes('#') ||
      url.href !== raw
    : url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      raw.includes('#') ||
      url.port !== '' ||
      url.href !== raw ||
      host.startsWith('[') ||
      /^\d+(?:\.\d+){3}$/u.test(host) ||
      !host.includes('.') ||
      host.endsWith('.') ||
      LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix))
  if (refused) throw new McpEventError({ reason: 'invalid_params', data: { field: 'delivery.url' } })
  return raw
}

const invalid = () => new McpEventError({ reason: 'invalid_params', data: { field: 'delivery.secret' } })

/** Decode a Standard Webhooks symmetric secret (`whsec_` + canonical base64 of 24–64 bytes). */
export const eventSecret = (secret: string): Uint8Array<ArrayBuffer> => {
  const encoded = secret.slice(6)
  if (!secret.startsWith('whsec_') || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw invalid()
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    throw invalid()
  }
  if (binary.length < 24 || binary.length > 64 || btoa(binary).replace(/=+$/u, '') !== encoded.replace(/=+$/u, ''))
    throw invalid()
  return Uint8Array.from(binary, unit => unit.charCodeAt(0))
}

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const sortedJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (isJsonObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortedJson(entry)] as const),
    )
  return value
}

/** JSON with object keys in canonical order (arrays keep theirs): the identity of a selector's arguments. */
export const canonicalEventJson = (value: Schema.Json): string => JSON.stringify(sortedJson(value))

/** Bytes in an owned ArrayBuffer, so Web Crypto takes them. */
export const eventBodyBytes = (body: string): Uint8Array<ArrayBuffer> => Uint8Array.from(encoder.encode(body))

/** A lease of 5 minutes to 24 hours; none asked for = 1 hour. */
export const eventTtlMs = (suggested: number | null | undefined): number =>
  Math.max(EVENT_LIMITS.minTtlMs, Math.min(suggested ?? EVENT_LIMITS.defaultTtlMs, EVENT_LIMITS.maxTtlMs))

const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** The stable id of a subscription: the connection (principal), the exact URL and the canonical selector. */
export const eventSubscriptionId = async (connectionId: string, selector: EventSelector, url: string) => {
  const bytes = encoder.encode(canonicalEventJson({ principal: connectionId, url, ...selector }))
  return `sub_${hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))}`
}
