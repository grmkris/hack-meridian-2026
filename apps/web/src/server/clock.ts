import { DateTime, Effect } from 'effect'

/** Current time as ISO-8601 UTC, through Effect's Clock (tests can move it with TestClock). */
export const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

/** ISO time `ms` milliseconds from now. */
export const isoIn = (ms: number) =>
  Effect.map(DateTime.now, now => DateTime.formatIso(DateTime.add(now, { milliseconds: ms })))

export const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis)

/** Milliseconds since the epoch of an ISO time; NaN when unreadable. */
export const millisOf = (iso: string) => Date.parse(iso)

/** A random id with a prefix: 16 random bytes, hex. */
export const randomId = (prefix: string) =>
  Effect.sync(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return `${prefix}_${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`
  })

/** 32 random bytes, base64url: session tokens and WebAuthn challenges. */
export const randomToken = Effect.sync(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '')
})

export const sha256Hex = (text: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  })
