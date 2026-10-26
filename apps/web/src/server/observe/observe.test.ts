import { Effect, Layer, Logger, Schema } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { requestContext, routeLabel } from './context.ts'
import { logEvent, logFailure, structuredLoggerLayer } from './log.ts'
import { annotate, redact } from './redact.ts'

/**
 * Logs are one JSON line each with short scalar fields only: the pretty logger is replaced, a message or memo passed
 * anywhere in a log call never reaches the line, errors become their tag, and addresses are shortened.
 */

class Offline extends Schema.TaggedError<Offline>()('Offline', { message: Schema.String }) {}

const LogLine = Schema.Record(Schema.String, Schema.Unknown)
const ADDRESS = 'CDOTWV7AICM5WKEIKQ7HTJWIPJJVZDND55VK7NOLPB7BDC76YLTNY4HC'

const capture = () => {
  const lines: Array<string> = []
  const layer = structuredLoggerLayer({ app: 'nod', stage: 'test', sink: (_level, line) => lines.push(line) })
  return { lines, layer, parsed: () => lines.map(line => Schema.decodeUnknownSync(LogLine)(JSON.parse(line))) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('structured logs', () => {
  test('the structured logger replaces the pretty one: one JSON line, nothing on the console', async () => {
    const printed: Array<unknown> = []
    vi.spyOn(console, 'log').mockImplementation((...args) => printed.push(args))
    const { lines, layer, parsed } = capture()
    await Effect.runPromise(
      Effect.logInfo('maintenance.finished').pipe(
        Effect.provide(layer.pipe(Layer.provide(Logger.layer([Logger.consolePretty()])))),
      ),
    )
    expect(lines).toHaveLength(1)
    expect(parsed()[0]).toMatchObject({ level: 'info', msg: 'maintenance.finished', app: 'nod', stage: 'test' })
    expect(printed).toEqual([])
  })

  test('a message, a memo or a reason passed to a log call never reaches the line', async () => {
    const { lines, layer, parsed } = capture()
    await Effect.runPromise(
      Effect.logWarning('pocket.create_failed', 'private message 123456', { memo: '987654', reason: 'dinner' }).pipe(
        annotate({ tool: 'payment_prepare', memo: '987654', note: 'secret note', address: ADDRESS }),
        Effect.provide(layer),
      ),
    )
    const joined = lines.join('\n')
    for (const leaked of ['private message', '987654', 'dinner', 'secret note', ADDRESS])
      expect(joined).not.toContain(leaked)
    expect(parsed()[0]).toMatchObject({ msg: 'pocket.create_failed', tool: 'payment_prepare', address: 'CDOT…Y4HC' })
  })

  test('a failure logs its tag and kind, never its message; a free-text event name is unlabelled', async () => {
    const { lines, layer, parsed } = capture()
    await Effect.runPromise(
      Effect.all([
        logFailure('error', 'wallet.create_failed', new Offline({ message: 'private provider content' })),
        logFailure('warn', 'revoke.pocket_sweep_failed', { _tag: 'ChainError', kind: 'declined', message: 'private' }),
        Effect.logError('createWallet failed: private detail'),
        Effect.fail(new Offline({ message: 'private cause' })).pipe(
          Effect.catchCause(cause => Effect.logError('authorize.failed', cause)),
        ),
      ]).pipe(Effect.provide(layer)),
    )
    expect(lines.join('\n')).not.toContain('private')
    expect(parsed()).toEqual([
      expect.objectContaining({ level: 'error', msg: 'wallet.create_failed', error_tag: 'Offline' }),
      expect.objectContaining({
        level: 'warn',
        msg: 'revoke.pocket_sweep_failed',
        error_tag: 'ChainError',
        error_code: 'declined',
      }),
      expect.objectContaining({ level: 'error', msg: 'unlabelled' }),
      expect.objectContaining({ level: 'error', msg: 'authorize.failed', error_tag: 'Offline' }),
    ])
  })

  test('redact keeps only allow-listed keys in their shape', () => {
    expect(
      redact({
        tool: 'payment_prepare',
        client: 'Claude Code',
        connection_id: `con_${'a'.repeat(32)}`,
        owner_id: 'own_da4a',
        amount: '0.10',
        input_sha256: 'f'.repeat(64),
        duration_ms: 12.3456,
        memo: '123',
        arguments: '{"memo":"123"}',
        tool_bad: 'x',
      }),
    ).toEqual({
      tool: 'payment_prepare',
      client: 'Claude Code',
      connection_id: `con_${'a'.repeat(32)}`,
      owner_id: 'own_da4a',
      amount: '0.10',
      input_sha256: 'f'.repeat(64),
      duration_ms: 12.346,
    })
    expect(redact({ owner_id: 'own_da4ac0970ccd3f0f173d18aa263acfb9', amount: 'ten', client: 'x'.repeat(41) })).toEqual(
      {},
    )
  })

  test('logEvent: below the minimum level nothing is written; route labels never carry the path', () => {
    const lines: Array<string> = []
    const scope = {
      app: 'nod',
      stage: 'test',
      requestId: 'ray-1',
      sink: (_: unknown, line: string) => lines.push(line),
    }
    logEvent({ ...scope, minLevel: 'warn' }, 'info', 'http.request', { http_route: '/api' })
    logEvent(scope, 'info', 'http.request', {
      http_method: 'GET',
      http_route: routeLabel('/claim/cl_abc123', ['/claim']),
    })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      msg: 'http.request',
      request_id: 'ray-1',
      http_route: '/claim',
    })
    expect(routeLabel('/my/secret/path', ['/api'])).toBe('unmatched')
  })

  test('the request id is cf-ray when it is a safe id, else a UUID, and the same for the same request', () => {
    const ray = new Request('https://trynod.si/mcp', { headers: { 'cf-ray': '8f1e2d3c4b5a6978-LIS' } })
    expect(requestContext(ray).requestId).toBe('8f1e2d3c4b5a6978-LIS')
    const injected = new Request('https://trynod.si/mcp', { headers: { 'cf-ray': 'x" {"level":"error"}' } })
    const id = requestContext(injected).requestId
    expect(id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(requestContext(injected).requestId).toBe(id)
  })
})
