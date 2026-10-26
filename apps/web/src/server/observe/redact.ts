import { Effect } from 'effect'
import * as Predicate from 'effect/Predicate'

/**
 * The only way a field reaches a log line. Every key is on an allow-list with a shape it must have; anything else is
 * dropped, whatever the caller passed. So a memo, a reason, a tool argument, an error message or a full address can
 * never land in a log by accident: they fail the shape (spaces, length, characters) or have no key to go under.
 */

export type LogFields = Record<string, string | number | boolean>

const ID = /^[A-Za-z0-9._:-]{1,64}$/u
const TAG = /^[A-Za-z0-9_.:-]{1,64}$/u
const STELLAR_ADDRESS = /^[GCM][A-Z2-7]{55,68}$/u

const id = (value: unknown) => (Predicate.isString(value) && ID.test(value) ? value : undefined)
const tag = (value: unknown) => (Predicate.isString(value) && TAG.test(value) ? value : undefined)
const count = (value: unknown) =>
  Predicate.isNumber(value) && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined
const oneOf =
  (...allowed: ReadonlyArray<string>) =>
  (value: unknown) =>
    Predicate.isString(value) && allowed.includes(value) ? value : undefined
const pattern = (re: RegExp) => (value: unknown) => (Predicate.isString(value) && re.test(value) ? value : undefined)

const SHORT_ADDRESS = /^[GCM][A-Z2-7]{3}…[A-Z2-7]{4}$/u

/** `GABC…WXYZ`: enough to tell two accounts apart in a log, never the address itself (already short: kept). */
export const shortAddress = (value: string) =>
  STELLAR_ADDRESS.test(value)
    ? `${value.slice(0, 4)}…${value.slice(-4)}`
    : SHORT_ADDRESS.test(value)
      ? value
      : undefined

const SHAPES: Readonly<Record<string, (value: unknown) => string | number | boolean | undefined>> = {
  request_id: id,
  tool: pattern(/^[a-z][a-z0-9_]{0,47}$/u),
  // An OAuth client's display name ("Claude", "ChatGPT", "Claude Code"): letters, digits, spaces and a few marks.
  client: pattern(/^[A-Za-z0-9 ._()-]{1,40}$/u),
  connection_id: pattern(/^con_[0-9a-f]{32}$/u),
  owner_id: pattern(/^own_[0-9a-f]{4}$/u),
  wallet_id: pattern(/^wal_[0-9a-f]{32}$/u),
  intent_id: pattern(/^[a-z]{2,3}_[0-9a-f]{32}$/u),
  amount: pattern(/^\d{1,12}(\.\d{1,7})?$/u),
  outcome: oneOf('ok', 'expected', 'unexpected', 'error', 'skipped', 'sent', 'new', 'known'),
  error_code: tag,
  error_tag: tag,
  error_family: oneOf('none', 'auth', 'rate_limit', 'not_found', 'invalid', 'client', 'server'),
  duration_ms: count,
  input_bytes: count,
  output_bytes: count,
  status_code: count,
  count,
  input_sha256: pattern(/^[0-9a-f]{64}$/u),
  http_method: pattern(/^[A-Z]{3,7}$/u),
  http_route: pattern(/^(\/[A-Za-z0-9._-]{0,32}){1,3}$|^unmatched$/u),
  address: (value: unknown) => (Predicate.isString(value) ? shortAddress(value) : undefined),
  network: oneOf('testnet', 'pubnet', 'stellar:testnet', 'stellar:pubnet'),
  kind: pattern(/^[a-z][a-z0-9_.:-]{0,79}$/u),
  label: tag,
  cron: pattern(/^[0-9*/, -]{1,32}$/u),
}

/** The fields that pass, in the order given; everything else dropped. */
export function redact(fields: Readonly<Record<string, unknown>>): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    const shape = SHAPES[key]
    if (shape === undefined) continue
    const safe = shape(value)
    if (safe !== undefined) out[key] = safe
  }
  return out
}

/** `Effect.annotateLogs` through `redact`: the one way to put a field on the lines of an effect. */
export const annotate =
  (fields: Readonly<Record<string, unknown>>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs(self, redact(fields))

/** An event name: lowercase, dotted (`mcp.tool`, `pocket.create_failed`). Anything else logs as `unlabelled`. */
export const EVENT = /^[a-z][a-z0-9_.-]{0,63}$/u
