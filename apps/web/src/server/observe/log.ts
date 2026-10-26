import { Cause, Context, Effect, Layer, Logger, References, Tracer } from 'effect'
import * as Predicate from 'effect/Predicate'

import { defaultSink, type LogLevel, type LogSink } from './context.ts'
import { codeOf, formatLine, tagOf } from './line.ts'
import { annotate, EVENT, redact } from './redact.ts'

/**
 * One JSON line per log (copied from ~/code/myapps/packages/observability/src/log.ts, made stricter): `msg` is the
 * event name (the first string of the log call, which must look like `mcp.tool`); every other field comes through
 * `redact` (observe/redact.ts), from the fiber's annotations or a plain object in the call; `error_tag` comes from
 * the log's Cause, never a message. Further strings in a call are dropped, so `Effect.logWarning('x', error.message)`
 * cannot leak the message.
 */

const SEVERITY: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

/** `Info` → `info`; `Fatal` and `Error` → `error`; `Debug`, `Trace` and `All` → `debug`. */
const levelOf = (level: string): LogLevel =>
  level === 'Fatal' || level === 'Error' ? 'error' : level === 'Warn' ? 'warn' : level === 'Info' ? 'info' : 'debug'

export interface LogScope {
  readonly app: string
  readonly stage: string
  readonly requestId?: string | undefined
  /** Lines below this level are dropped (LOG_LEVEL). Default `info`. */
  readonly minLevel?: LogLevel | undefined
  readonly sink?: LogSink | undefined
}

/**
 * One line outside Effect (the Worker's `http.request`, the scheduled handler): `msg` names the event, `fields` go
 * through `redact`. Never throws.
 */
export function logEvent(
  scope: LogScope,
  level: LogLevel,
  msg: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  try {
    if (SEVERITY[level] < SEVERITY[scope.minLevel ?? 'info']) return
    ;(scope.sink ?? defaultSink)(
      level,
      formatLine({
        ...redact(fields),
        level,
        msg: EVENT.test(msg) ? msg : 'unlabelled',
        ts: new Date().toISOString(),
        app: scope.app,
        stage: scope.stage,
        request_id: scope.requestId,
      }),
    )
  } catch {
    // Logging must never change behaviour.
  }
}

/**
 * The Effect `Logger` layer for the app's runtime: replaces the default (pretty) loggers with the one-line JSON
 * shape above, the current span's ids included.
 */
export const structuredLoggerLayer = (options: {
  readonly app: string
  readonly stage: string
  readonly sink?: LogSink | undefined
}): Layer.Layer<never> => {
  const sink = options.sink ?? defaultSink
  const logger = Logger.make(log => {
    try {
      const span = Context.getOrUndefined(log.fiber.context, Tracer.ParentSpan)
      const level = levelOf(log.logLevel)
      const message: ReadonlyArray<unknown> = Array.isArray(log.message) ? log.message : [log.message]
      const annotations = log.fiber.getRef(References.CurrentLogAnnotations)
      const first = message[0]
      const parts: Record<string, unknown> = {}
      for (const part of message.slice(1)) {
        if (Predicate.isObject(part) && !Array.isArray(part) && Object.getPrototypeOf(part) === Object.prototype)
          Object.assign(parts, part)
        else if (Predicate.isObject(part) && !Predicate.isString(parts['error_tag'])) parts['error_tag'] = tagOf(part)
      }
      const fields = redact({ ...annotations, ...parts })
      if (log.cause.reasons.length > 0) fields['error_tag'] = tagOf(Cause.squash(log.cause))
      const requestId = annotations['request_id']
      sink(
        level,
        formatLine({
          ...fields,
          level,
          msg: Predicate.isString(first) && EVENT.test(first) ? first : 'unlabelled',
          ts: log.date.toISOString(),
          app: options.app,
          stage: options.stage,
          request_id: Predicate.isString(requestId)
            ? redact({ request_id: requestId })['request_id']?.toString()
            : undefined,
          trace_id: span?.traceId,
          span_id: span?.spanId,
        }),
      )
    } catch {
      // never throw from a logger
    }
  })
  return Logger.layer([logger], { mergeWithExisting: false })
}

/** LOG_LEVEL (`Debug`, `Info`, `Warn`, `Error`; anything else `Info`) as Effect's level and as a line level. */
export const logLevelOf = (text: string | undefined) => {
  const effect = text === 'Debug' || text === 'Warn' || text === 'Error' ? text : ('Info' as const)
  return { effect, line: levelOf(effect) }
}

/**
 * A failure as a log line: the event name, the error's tag (and `error_code` from a `kind` or `code` field), plus
 * redacted fields. Never the error's message. `Effect.logWarning(event, error.message)` is what this replaces.
 */
export const logFailure = (
  level: 'warn' | 'error',
  event: string,
  error: unknown,
  fields: Readonly<Record<string, unknown>> = {},
) => {
  const kind = Predicate.isObject(error) && Predicate.isString(error['kind']) ? error['kind'] : undefined
  return (level === 'error' ? Effect.logError(event) : Effect.logWarning(event)).pipe(
    annotate({ ...fields, error_tag: tagOf(error), error_code: kind ?? codeOf(error) }),
  )
}
