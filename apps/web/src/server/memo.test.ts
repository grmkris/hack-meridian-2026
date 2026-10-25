import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { makeApiHandler } from './app.ts'
import type { ConnectionProps } from './props.ts'
import { first, sql } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { createSession } from './store.ts'
import { testServices } from './test/layers.ts'
import { BOB, OWNER_ID, SIGNER, WALLET_ID, seedWallet } from './test/seed.ts'
import { MEMO_UNSUPPORTED, paymentPrepare, ToolError, type ToolContext } from './tools.ts'

/**
 * No transaction Nod builds carries a memo, so an exchange deposit address that needs one would lose the money. A memo
 * is refused with a plain sentence wherever one can be given (payment_prepare, the owner's contact endpoints), and
 * nothing is prepared or saved; without one, both work as before.
 */

const ORIGIN = 'https://wallet.test'
const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

const world = async () => {
  const runtime: AppRuntime = ManagedRuntime.make(testServices())
  runtimes.push(runtime)
  await runtime.runPromise(seedWallet())
  const token = await runtime.runPromise(createSession(OWNER_ID))
  const api = makeApiHandler(Layer.succeedContext(await runtime.context()))
  const call = async (method: 'POST' | 'PATCH', path: string, body: unknown) => {
    const response = await api.handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { cookie: `hm_owner=${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: (await response.json()) as unknown }
  }
  const props: ConnectionProps = {
    owner_id: OWNER_ID,
    wallet_id: WALLET_ID,
    connection_id: 'con_a',
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
  const ctx: ToolContext = { props, origin: ORIGIN }
  const count = (table: 'payment_intents' | 'contacts') =>
    runtime.runPromise(
      Effect.map(
        first(sql(`SELECT count(*) AS n FROM ${table}`), row => Effect.succeed(Number(row['n']))),
        n => n ?? 0,
      ),
    )
  return { runtime, call, ctx, count, dispose: api.dispose }
}

describe('a memo is refused, never dropped', () => {
  test('payment_prepare with a memo answers the sentence and prepares nothing', async () => {
    const w = await world()
    const refused = await w.runtime.runPromise(
      Effect.flip(paymentPrepare(w.ctx, { recipient: BOB, amount: '1', memo: '123456', idempotency_key: 'memo-1' })),
    )
    expect(refused).toBeInstanceOf(ToolError)
    expect(refused.message).toContain('Nod cannot pay exchange deposit addresses that need a memo yet.')
    expect(await w.count('payment_intents')).toBe(0)
    await w.dispose()
  })

  test('payment_prepare with an empty memo or none still prepares', async () => {
    const w = await world()
    const blank = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: BOB, amount: '1', memo: ' ', idempotency_key: 'memo-2' }),
    )
    expect(blank.value.status).toBe('prepared')
    const none = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: BOB, amount: '1', idempotency_key: 'memo-3' }),
    )
    expect(none.value.status).toBe('prepared')
    await w.dispose()
  })

  test('the owner cannot save or change a contact with a memo; without one it saves', async () => {
    const w = await world()
    const before = await w.count('contacts')
    const refused = await w.call('POST', '/api/contacts', { display_name: 'Exchange', address: BOB, memo: '42' })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.body)).toContain(MEMO_UNSUPPORTED)
    expect(await w.count('contacts')).toBe(before)

    const saved = await w.call('POST', '/api/contacts', { display_name: 'Bob', address: BOB })
    expect(saved.status).toBe(200)
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(saved.body)
    const changed = await w.call('PATCH', `/api/contacts/${id}`, { address: BOB, memo: '42', confirm: true })
    expect(changed.status).toBe(400)
    expect(JSON.stringify(changed.body)).toContain(MEMO_UNSUPPORTED)
    await w.dispose()
  })
})
