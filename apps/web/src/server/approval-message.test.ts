import { describe, expect, test } from 'vitest'

import { contactAdd } from './contacts-tools.ts'
import { senderWorld } from './test/sender.ts'
import { paymentExecute, paymentPrepare } from './tools.ts'

/**
 * approval_message: the sentence for the owner that a host shows beside the approval link (Goblin's URL request card),
 * set only while a payment waits for the nod.
 */

const DAVE = 'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ERIN = 'GERINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe('approval_message', () => {
  test('names the amount, the payee (or a short address) and the network while the payment waits for the nod', async () => {
    const w = await senderWorld()
    const over = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: DAVE, amount: '12', idempotency_key: 'over-1' }),
    )
    expect(over.value.status).toBe('awaiting_approval')
    expect(over.value.approval_message).toBe('Your AI app asks to pay 12 USDC to GDAV…AAAA on Stellar Testnet.')
    await w.runtime.runPromise(contactAdd(w.ctx, { name: 'Jan', address: ERIN, idempotency_key: 'add-jan' }))
    const saved = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: 'Jan', amount: '1.50', idempotency_key: 'jan-1' }),
    )
    expect(saved.value.approval_message).toBe('Your AI app asks to pay 1.5 USDC to Jan on Stellar Testnet.')
  })

  test('is null on a payment inside the allowance, before and after it is paid', async () => {
    const w = await senderWorld()
    const ready = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: DAVE, amount: '1', idempotency_key: 'in-1' }),
    )
    expect(ready.value.approval_message).toBeNull()
    const paid = await w.runtime.runPromise(paymentExecute(w.ctx, ready.value.payment_id))
    expect(paid.value).toMatchObject({ status: 'confirmed', approval_message: null })
  })
})
