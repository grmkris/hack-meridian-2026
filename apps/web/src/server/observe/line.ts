import * as Predicate from 'effect/Predicate'

import type { LogLevel } from './context.ts'

/**
 * One structured log line (copied from ~/code/myapps/packages/observability/src/line.ts, trimmed to Nod's fields).
 * Every field is a short scalar: ids, sizes, outcomes, tags. Never a message, memo, reason, argument or full address.
 */

const TAG = /^[A-Za-z0-9_.:-]{1,64}$/u

/** Where a failure belongs: none (it worked), the caller's input or rights, or our side. */
export type ErrorFamily = 'none' | 'auth' | 'rate_limit' | 'not_found' | 'invalid' | 'client' | 'server'

/** A short tag for an error: its `_tag`, `code`, `tag` or `name`. Never its message. */
export function tagOf(e: unknown): string {
  if (Predicate.isObject(e)) {
    for (const key of ['_tag', 'code', 'tag', 'name'] as const) {
      const v = e[key]
      if (Predicate.isString(v) && TAG.test(v)) return v
    }
  }
  return 'Error'
}

/** A scalar `code` of an error: a finite number or a short tag-like string. Never a message. */
export function codeOf(e: unknown): string | number | undefined {
  if (!Predicate.isObject(e)) return undefined
  const v = e['code']
  if (Predicate.isNumber(v)) return Number.isFinite(v) ? v : undefined
  return Predicate.isString(v) && TAG.test(v) ? v : undefined
}

/** Field order of every line. Empty / undefined fields are omitted. */
export interface LogRecord {
  level: LogLevel
  msg: string
  ts: string
  app: string
  stage?: string | undefined
  request_id?: string | undefined
  trace_id?: string | undefined
  span_id?: string | undefined
  [field: string]: string | number | boolean | undefined
}

/** Serialise one record: JSON, empty fields dropped. */
export function formatLine(record: LogRecord): string {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === '') continue
    out[key] = value
  }
  return JSON.stringify(out)
}
