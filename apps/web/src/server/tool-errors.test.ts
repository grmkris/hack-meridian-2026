import { Predicate, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import errorsMarkdown from '../../public/skill/nod-guide/references/errors.md?raw'
import { contactAdd } from './contacts-tools.ts'
import { callTool } from './mcp-tools.ts'
import { senderWorld } from './test/sender.ts'
import { RECOVERY, RETRY } from './tool-errors.ts'
import { paymentExecute, paymentPrepare } from './tools.ts'

/**
 * Refusals as an AI app reads them: one JSON text block { error: { code, message, recovery, retry } } with isError and
 * no structuredContent; the recovery sentences are the bundled skill's (references/errors.md), word for word.
 */

const DAVE = 'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ERIN = 'GERINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SKILL_CODES = [
  'ambiguous_recipient',
  'no_contact',
  'account_missing',
  'memo_unsupported',
  'payments_paused',
  'revoked',
  'no_allowance',
  'idempotency_conflict',
  'upstream_unavailable',
  'topup_unavailable',
  'invalid_input',
  'not_found',
]

const Refusal = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    recovery: Schema.String,
    retry: Schema.String,
    candidates: Schema.optional(
      Schema.Array(Schema.Struct({ contact_id: Schema.String, name: Schema.String, address: Schema.String })),
    ),
  }),
})

/** The refusal in a tools/call result, after checking its wire shape. */
const refusalOf = (result: Record<string, unknown>) => {
  expect(result['isError']).toBe(true)
  expect(result['structuredContent']).toBeUndefined()
  const content = Array.isArray(result['content']) ? result['content'] : []
  expect(content).toHaveLength(1)
  const block: unknown = content[0]
  const text = Predicate.isObject(block) && typeof block['text'] === 'string' ? block['text'] : ''
  return Schema.decodeUnknownSync(Schema.fromJsonString(Refusal))(text).error
}

describe('tool refusals', () => {
  test('RECOVERY says what the skill says, code for code', () => {
    const block = /```json\n([\s\S]*?)\n```/u.exec(errorsMarkdown)?.[1] ?? '{}'
    const skill = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(block)
    expect(Object.keys(skill)).toEqual(SKILL_CODES)
    for (const [code, sentence] of Object.entries(skill)) expect(RECOVERY).toHaveProperty(code, sentence)
    expect(Object.keys(RECOVERY)).toEqual(SKILL_CODES)
  })

  test('an unknown name is no_contact: JSON text, isError, no structuredContent, the recovery and a new key', async () => {
    const w = await senderWorld()
    const result = await callTool(w.runtime, w.ctx, 'payment_prepare', {
      recipient: 'Nobody',
      amount: '1',
      idempotency_key: 'nobody-1',
    })
    expect(refusalOf(result)).toEqual({
      code: 'no_contact',
      message: 'No saved contact matches "Nobody". Use contacts_search, or give a Stellar address.',
      recovery: RECOVERY.no_contact,
      retry: 'new-key',
    })
  })

  test('no_contact names the most recent payment whose address starts with what the user said, as the next call', async () => {
    const w = await senderWorld()
    const prepared = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: DAVE, amount: '1', idempotency_key: 'dave-1' }),
    )
    await w.runtime.runPromise(paymentExecute(w.ctx, prepared.value.payment_id))
    const refusal = refusalOf(
      await callTool(w.runtime, w.ctx, 'payment_prepare', { recipient: 'gdave', amount: '1', idempotency_key: 'g-1' }),
    )
    expect(refusal.code).toBe('no_contact')
    expect(refusal.recovery).toContain(`This wallet paid this address (${DAVE}) on 20`)
    expect(refusal.recovery).toContain(
      `call payment_prepare with recipient "${DAVE}", the amount and a new idempotency_key`,
    )
  })

  test('a name two contacts share is ambiguous_recipient with both as candidates', async () => {
    const w = await senderWorld()
    for (const [name, address] of [
      ['Jan Novak', DAVE],
      ['Jan Kos', ERIN],
    ] as const)
      await w.runtime.runPromise(contactAdd(w.ctx, { name, address, idempotency_key: `add-${name}` }))
    const refusal = refusalOf(
      await callTool(w.runtime, w.ctx, 'payment_prepare', { recipient: 'Jan', amount: '1', idempotency_key: 'jan-1' }),
    )
    expect(refusal.code).toBe('ambiguous_recipient')
    expect(refusal.retry).toBe(RETRY.ambiguous_recipient)
    expect(refusal.candidates?.map(candidate => [candidate.name, candidate.address]).toSorted()).toEqual([
      ['Jan Kos', ERIN],
      ['Jan Novak', DAVE],
    ])
  })

  test('bad arguments and an unknown tool are invalid_input and not_found', async () => {
    const w = await senderWorld()
    expect(
      refusalOf(
        await callTool(w.runtime, w.ctx, 'payment_prepare', { recipient: DAVE, amount: '0', idempotency_key: 'z' }),
      ).code,
    ).toBe('invalid_input')
    const unknown = refusalOf(await callTool(w.runtime, w.ctx, 'payment_teleport', {}))
    expect(unknown).toMatchObject({ code: 'not_found', retry: 'read' })
  })
})
