import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import { contactAdd, contactRemove } from './contacts-tools.ts'
import { sql, write } from './rows.ts'
import { searchContacts } from './store.ts'
import { OWNER, senderWorld } from './test/sender.ts'
import { paymentExecute, paymentPrepare, paymentStatus, resolveRecipient, walletOverview } from './tools.ts'

/**
 * Recipient memory: a raw address the user names is remembered once paid (a label, and a contact marked as saved by
 * the AI app with source 'paid'), so "send 0.02 to Chris" afterwards pays alone inside the allowance; names resolve
 * after contacts by those labels and past receipts; wallet_overview lists recent recipients; payment_status can wait.
 */

const DAVE = 'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ERIN = 'GERINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

type World = Awaited<ReturnType<typeof senderWorld>>

/** Prepare and, when it may go alone, execute: the executed (or prepared) view and its sentence. */
const send = async (w: World, recipient: string, amount: string, key: string, recipientName?: string) => {
  const prepared = await w.runtime.runPromise(
    paymentPrepare(w.ctx, {
      recipient,
      amount,
      idempotency_key: key,
      ...(recipientName === undefined ? {} : { recipient_name: recipientName }),
    }),
  )
  if (prepared.value.status !== 'prepared') return { prepared, executed: undefined }
  return { prepared, executed: await w.runtime.runPromise(paymentExecute(w.ctx, prepared.value.payment_id)) }
}

describe('recipient memory', () => {
  test('a raw address paid with a name becomes a contact saved by the app; "send 0.02 to Chris" then pays alone', async () => {
    const w = await senderWorld()
    const first = await send(w, DAVE, '1', 'chris-1', 'Chris')
    expect(first.executed?.value.status).toBe('confirmed')
    expect(first.executed?.value.recipient.name).toBe('Chris')
    expect(first.executed?.sentence).toContain('Saved Chris as a contact.')
    const [chris] = await w.runtime.runPromise(searchContacts(OWNER, 'Chris'))
    expect(chris).toMatchObject({ display_name: 'Chris', added_by: 'Claude' })
    expect(chris?.destinations[0]).toMatchObject({ address: DAVE, source: 'paid' })
    expect(chris?.destinations[0]?.last_paid_at).not.toBeNull()
    const again = await send(w, 'Chris', '0.02', 'chris-2')
    expect(again.prepared.value).toMatchObject({ lane: 'autonomous', approval_url: null })
    expect(again.executed?.value.status).toBe('confirmed')
    expect(again.executed?.sentence).not.toContain('Saved')
  })

  test('pay a raw address, then contact_add the same address: paying by name goes alone', async () => {
    const w = await senderWorld()
    expect((await send(w, DAVE, '1', 'raw-1')).executed?.value.status).toBe('confirmed')
    expect(await w.runtime.runPromise(searchContacts(OWNER, DAVE))).toEqual([])
    await w.runtime.runPromise(contactAdd(w.ctx, { name: 'Chris', address: DAVE, idempotency_key: 'add-chris' }))
    const byName = await send(w, 'Chris', '0.02', 'chris-1')
    expect(byName.prepared.value).toMatchObject({ lane: 'autonomous', approval_url: null })
    expect(byName.executed?.value.status).toBe('confirmed')
  })

  test('after the owner removes the saved contact, the name still pays the address and the contact stays gone', async () => {
    const w = await senderWorld()
    await send(w, ERIN, '1', 'erin-1', 'Erin')
    const [erin] = await w.runtime.runPromise(searchContacts(OWNER, 'Erin'))
    await w.runtime.runPromise(contactRemove(w.ctx, { contact: erin?.id ?? '', idempotency_key: 'rm-erin' }))
    const resolved = await w.runtime.runPromise(resolveRecipient(OWNER, 'wal_s', 'erin'))
    expect(resolved).toEqual({ address: ERIN, name: 'Erin', contactId: null })
    const again = await send(w, 'Erin', '0.5', 'erin-2')
    expect(again.executed?.value.status).toBe('confirmed')
    expect(again.executed?.sentence).not.toContain('Saved')
    expect(await w.runtime.runPromise(searchContacts(OWNER, 'Erin'))).toEqual([])
  })

  test('one name paid at two addresses, without contacts, is ambiguous_recipient with both addresses', async () => {
    const w = await senderWorld()
    await send(w, DAVE, '1', 'sam-1', 'Sam')
    await send(w, ERIN, '1', 'sam-2', 'Sam')
    for (const contact of await w.runtime.runPromise(searchContacts(OWNER, 'Sam')))
      await w.runtime.runPromise(contactRemove(w.ctx, { contact: contact.id, idempotency_key: `rm-${contact.id}` }))
    const refused = await w.runtime.runPromise(Effect.flip(resolveRecipient(OWNER, 'wal_s', 'Sam')))
    expect(refused).toMatchObject({ _tag: 'ToolError', code: 'ambiguous_recipient' })
    const candidates = refused._tag === 'ToolError' ? (refused.candidates ?? []) : []
    expect(candidates.map(candidate => [candidate.contact_id, candidate.address])).toEqual(
      expect.arrayContaining([
        [null, DAVE],
        [null, ERIN],
      ]),
    )
    expect(candidates).toHaveLength(2)
  })

  test('wallet_overview lists recent recipients, newest first, with the name and the address prefix', async () => {
    const w = await senderWorld()
    await send(w, DAVE, '1', 'r-1', 'Chris')
    await send(w, ERIN, '1', 'r-2')
    const overview = await w.runtime.runPromise(walletOverview(w.ctx))
    expect(overview.value.recent_recipients.map(row => [row.name, row.address_prefix])).toEqual([
      [null, ERIN.slice(0, 8)],
      ['Chris', DAVE.slice(0, 8)],
    ])
  })
})

describe('payment_status wait_seconds', () => {
  test('answers at once for a settled payment, and waits until the status changes for one awaiting the nod', async () => {
    const w = await senderWorld()
    const paid = await send(w, DAVE, '1', 'w-1')
    const started = performance.now()
    const settled = await w.runtime.runPromise(paymentStatus(w.ctx, paid.prepared.value.payment_id, 30))
    expect(settled.value.status).toBe('confirmed')
    expect(performance.now() - started).toBeLessThan(1000)
    const big = await send(w, DAVE, '12', 'w-2')
    expect(big.prepared.value.status).toBe('awaiting_approval')
    const id = big.prepared.value.payment_id
    const waited = await w.runtime.runPromise(
      Effect.all(
        [
          paymentStatus(w.ctx, id, 30),
          Effect.delay(write(sql("UPDATE payment_intents SET status = 'expired' WHERE id = ?", id)), '300 millis'),
        ],
        { concurrency: 2 },
      ),
    )
    expect(waited[0].value.status).toBe('expired')
  })

  test('gives up after wait_seconds with the status unchanged', async () => {
    const w = await senderWorld()
    const big = await send(w, DAVE, '12', 'w-3')
    const started = performance.now()
    const waited = await w.runtime.runPromise(paymentStatus(w.ctx, big.prepared.value.payment_id, 1))
    expect(waited.value.status).toBe('awaiting_approval')
    expect(performance.now() - started).toBeGreaterThanOrEqual(900)
  })
})
