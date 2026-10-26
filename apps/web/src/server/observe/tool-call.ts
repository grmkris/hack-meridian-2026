import { Cause, Clock, Effect, Predicate } from 'effect'

import type { ToolRunResult } from '../mcp-tools.ts'
import type { ErrorFamily } from './line.ts'
import { tagOf } from './line.ts'
import { annotate } from './redact.ts'

/**
 * The `mcp.tool` line: one per tool call on either MCP lane (mcp-tools.ts runTool). Who called (client, connection,
 * an 8-character owner prefix), which tool, how it ended (ok, an expected refusal with its code, or an unexpected
 * failure with its cause's tag), how long it took, and the input's size and SHA-256. Never the arguments: a memo, a
 * reason or an address in them cannot reach the line, only their hash. A payment's id and amount when the result
 * carries them.
 */

export type ToolOutcome =
  | { readonly outcome: 'ok'; readonly value: unknown }
  | { readonly outcome: 'expected'; readonly code: string }
  | { readonly outcome: 'unexpected'; readonly cause: Cause.Cause<unknown> }

export interface ToolCaller {
  readonly props: {
    readonly owner_id: string
    readonly connection_id: string
    readonly client_name: string
  }
  /** The request's id (observe/context.ts), when the call came through the Worker. */
  readonly requestId?: string | undefined
}

/** Where a refusal code belongs (the line's `error_family`). */
export const familyOf = (code: string): ErrorFamily => {
  switch (code) {
    case 'invalid_input':
      return 'invalid'
    case 'not_found':
    case 'no_contact':
    case 'account_missing':
      return 'not_found'
    case 'revoked':
    case 'no_allowance':
      return 'auth'
    case 'payments_paused':
    case 'upstream_unavailable':
    case 'topup_unavailable':
      return 'server'
    default:
      return 'client'
  }
}

const sha256Hex = (text: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  })

/** A payment's id and amount from a tool's value (PaymentView and friends), when present. */
const paymentOf = (value: unknown) =>
  Predicate.isObject(value)
    ? {
        intent_id: Predicate.isString(value['payment_id']) ? value['payment_id'] : undefined,
        amount: Predicate.isString(value['amount']) ? value['amount'] : undefined,
      }
    : {}

/**
 * Runs one tool call (`call` yields the wire result and how it ended), then writes its `mcp.tool` line. Returns the
 * wire result with the request id in `_meta` when known.
 */
export const observeToolCall = <E, R>(
  scope: { readonly tool: string; readonly caller: ToolCaller; readonly args: unknown },
  call: Effect.Effect<{ readonly run: ToolRunResult; readonly ended: ToolOutcome }, E, R>,
): Effect.Effect<ToolRunResult, E, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const input = JSON.stringify(scope.args ?? {}) ?? '{}'
    const { run, ended } = yield* call
    const duration = (yield* Clock.currentTimeMillis) - started
    const fields = {
      request_id: scope.caller.requestId,
      tool: scope.tool,
      client: scope.caller.props.client_name,
      connection_id: scope.caller.props.connection_id,
      owner_id: scope.caller.props.owner_id.slice(0, 8),
      outcome: ended.outcome,
      error_code: ended.outcome === 'expected' ? ended.code : undefined,
      error_family: ended.outcome === 'ok' ? 'none' : ended.outcome === 'expected' ? familyOf(ended.code) : 'server',
      error_tag: ended.outcome === 'unexpected' ? tagOf(Cause.squash(ended.cause)) : undefined,
      duration_ms: duration,
      input_bytes: new TextEncoder().encode(input).length,
      input_sha256: yield* sha256Hex(input),
      ...(ended.outcome === 'ok' ? paymentOf(ended.value) : {}),
    }
    const line =
      ended.outcome === 'ok'
        ? Effect.logInfo('mcp.tool')
        : ended.outcome === 'expected'
          ? Effect.logWarning('mcp.tool')
          : Effect.logError('mcp.tool')
    yield* line.pipe(annotate(fields))
    const ref = scope.caller.requestId
    return ref === undefined
      ? run
      : { ...run, result: { ...run.result, _meta: { ...run.result['_meta'], 'nod/ref': ref } } }
  })
