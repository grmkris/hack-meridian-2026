import { Cause, Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { runTool } from '../mcp-tools.ts'
import type { ConnectionProps } from '../props.ts'
import type { AppRuntime } from '../runtime.ts'
import { testServices } from '../test/layers.ts'
import { BOB, OWNER_ID, SIGNER, WALLET_ID, seedWallet } from '../test/seed.ts'
import { structuredLoggerLayer } from './log.ts'
import { observeToolCall } from './tool-call.ts'

/**
 * One `mcp.tool` line per tool call, on the single path both MCP lanes take: who, which tool, how it ended and how
 * long it took, the input's size and hash, never the input. The request id rides back in the result's `_meta`.
 */

class Offline extends Schema.TaggedError<Offline>()('Offline', { message: Schema.String }) {}

const LogLine = Schema.Record(Schema.String, Schema.Unknown)
const props: ConnectionProps = {
  owner_id: OWNER_ID,
  wallet_id: WALLET_ID,
  connection_id: 'con_0123456789abcdef0123456789abcdef',
  client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
  client_name: 'Claude Code',
  client_domain: 'claude.ai',
  granted_at: '2026-10-25T12:00:00.000Z',
  grant: {
    grant_id: 'gr_a',
    allowance: '5.00',
    valid_until: '2099-01-01T00:00:00.000Z',
    rule_id: 1,
    signer_public_key: SIGNER,
  },
}

const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

const world = async () => {
  const lines: Array<string> = []
  const runtime: AppRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      testServices(),
      structuredLoggerLayer({ app: 'nod', stage: 'test', sink: (_level, line) => lines.push(line) }),
    ),
  )
  runtimes.push(runtime)
  await runtime.runPromise(seedWallet({ connectionId: props.connection_id }))
  const toolLines = () =>
    lines.map(line => Schema.decodeUnknownSync(LogLine)(JSON.parse(line))).filter(line => line['msg'] === 'mcp.tool')
  return { runtime, lines, toolLines }
}

describe('the mcp.tool line', () => {
  test('a call with a memo and a reason: one warn line with the code, nothing of the input, the ref in _meta', async () => {
    const w = await world()
    const ran = await runTool(
      w.runtime,
      { props, origin: 'https://wallet.test', requestId: 'ray-test-1' },
      'payment_prepare',
      {
        recipient: BOB,
        amount: '1',
        memo: 'SECRETMEMO42',
        reason: 'private dinner with Bob',
        idempotency_key: 'memo-log-1',
      },
    )
    expect(ran.result.isError).toBe(true)
    expect(ran.result['_meta']).toEqual({ 'nod/ref': 'ray-test-1' })
    const joined = w.lines.join('\n')
    for (const leaked of ['SECRETMEMO42', 'private dinner', BOB, 'memo-log-1']) expect(joined).not.toContain(leaked)
    const lines = w.toolLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 'warn',
      request_id: 'ray-test-1',
      tool: 'payment_prepare',
      client: 'Claude Code',
      connection_id: props.connection_id,
      outcome: 'expected',
      error_code: 'memo_unsupported',
      error_family: 'client',
    })
    expect(lines[0]?.['input_sha256']).toMatch(/^[0-9a-f]{64}$/u)
    expect(lines[0]?.['input_bytes']).toBeGreaterThan(0)
  })

  test('a call that works: one info line, outcome ok; an unknown tool: one warn line as unknown', async () => {
    const w = await world()
    await runTool(w.runtime, { props, origin: 'https://wallet.test' }, 'wallet_overview', {})
    await runTool(w.runtime, { props, origin: 'https://wallet.test' }, 'drain_wallet', { all: true })
    expect(w.toolLines().map(line => [line['level'], line['tool'], line['outcome'], line['error_code']])).toEqual([
      ['info', 'wallet_overview', 'ok', undefined],
      ['warn', 'unknown', 'expected', 'not_found'],
    ])
  })

  test('an unexpected failure: one error line with the cause tag, never its message', async () => {
    const lines: Array<string> = []
    await Effect.runPromise(
      observeToolCall(
        { tool: 'payment_execute', caller: { props }, args: { payment_id: 'pi_x' } },
        Effect.succeed({
          run: { result: { content: [] }, value: undefined },
          ended: {
            outcome: 'unexpected',
            cause: Cause.fail(new Offline({ message: 'private upstream text' })),
          } as const,
        }),
      ).pipe(
        Effect.provide(structuredLoggerLayer({ app: 'nod', stage: 'test', sink: (_level, line) => lines.push(line) })),
      ),
    )
    expect(lines.join('\n')).not.toContain('private upstream text')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 'error',
      msg: 'mcp.tool',
      outcome: 'unexpected',
      error_tag: 'Offline',
      error_family: 'server',
    })
  })
})
