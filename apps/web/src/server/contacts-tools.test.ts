import { Effect, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { describe, expect, test } from 'vitest'

import { makeFixtureChain, toStroops } from '@hm/protocol'
import type { SoftPasskey } from '@hm/stellar/testing'

import { claimLink } from './claims.ts'
import {
  connectionGrantUpdate,
  contactAdd,
  contactRemove,
  contactUpdate,
  paymentsList,
  walletDepositAddress,
} from './contacts-tools.ts'
import { sql, write } from './rows.ts'
import { createContact, grantOfConnection } from './store.ts'
import { BOB } from './test/seed.ts'
import { CONNECTION, ORIGIN, OWNER, senderWorld } from './test/sender.ts'
import { contactsSearch, paymentExecute, paymentPrepare } from './tools.ts'

/**
 * The tools after the first fifteen. The lane rule they bring: the first payment to an address an AI app saved
 * (contact_add, a new address by contact_update) takes the owner lane whatever the amount, unless the wallet already
 * knows the address (paid it, met it on a claim link, a paid request). The owner's own contacts are unchanged.
 */

const DAVE = 'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ERIN = 'GERINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const pay = (ctx: Parameters<typeof paymentPrepare>[0], recipient: string, amount: string, key: string) =>
  paymentPrepare(ctx, { recipient, amount, idempotency_key: key })

describe('the lane rule for contacts an AI app saved', () => {
  test('contact_add marks the contact; its first payment needs the nod even at 1 USDC; the owner’s own do not', async () => {
    const w = await senderWorld()
    const added = await w.runtime.runPromise(
      contactAdd(w.ctx, { name: 'Dave', address: DAVE, aliases: ['dave from work'], idempotency_key: 'add-dave' }),
    )
    expect(added.value).toMatchObject({ result: 'added', contact: { name: 'Dave', added_by: 'Claude' } })
    expect(added.sentence).toContain("the first payment to Dave needs the user's nod")
    const first = await w.runtime.runPromise(pay(w.ctx, 'Dave', '1', 'dave-1'))
    expect(first.value).toMatchObject({ status: 'awaiting_approval', lane: 'owner', approval_reason: 'new_contact' })
    expect(first.sentence).toContain('goes to an address an AI app saved')
    expect(first.sentence).toContain(first.value.approval_url ?? 'missing')
    expect((await w.runtime.runPromise(paymentExecute(w.ctx, first.value.payment_id))).value.status).toBe(
      'awaiting_approval',
    )
    expect(w.fixture.callsOf('delegatedTransfer')).toHaveLength(0)

    // The owner's own contact pays inside the allowance as before.
    await w.runtime.runPromise(
      createContact({
        ownerId: OWNER,
        displayName: 'Bob',
        aliases: [],
        address: BOB,
        memo: null,
        readiness: 'usdc_ready',
      }),
    )
    expect((await w.runtime.runPromise(pay(w.ctx, 'Bob', '1', 'bob-1'))).value.lane).toBe('autonomous')

    // Once paid (the owner's nod went through), Dave is no longer new.
    await w.runtime.runPromise(
      write(sql("UPDATE contact_destinations SET last_paid_at = '2026-10-25T20:00:00.000Z' WHERE address = ?", DAVE)),
    )
    expect((await w.runtime.runPromise(pay(w.ctx, 'Dave', '1', 'dave-2'))).value.lane).toBe('autonomous')
  })

  test('an address the wallet already knows (chosen on its claim link) is not new; a changed address is', async () => {
    const w = await senderWorld()
    const link = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: 'new', recipient_name: 'Erin', amount: '1', idempotency_key: 'erin-link' }),
    )
    await w.runtime.runPromise(claimLink(link.value.payment_id, { kind: 'address', address: ERIN }))
    // The paid claim saved Erin as the owner's contact; the AI app removes it and adds it back as its own.
    await w.runtime.runPromise(contactRemove(w.ctx, { contact: 'Erin', idempotency_key: 'rm-erin' }))
    const again = await w.runtime.runPromise(
      contactAdd(w.ctx, { name: 'Erin', address: ERIN, idempotency_key: 'add-erin' }),
    )
    expect(again.sentence).toContain('already knows this address')
    expect((await w.runtime.runPromise(pay(w.ctx, 'Erin', '1', 'erin-1'))).value.lane).toBe('autonomous')

    // contact_update to an address nobody met: the first payment there needs the nod again.
    const moved = await w.runtime.runPromise(
      contactUpdate(w.ctx, { contact: 'Erin', address: DAVE, idempotency_key: 'erin-moves' }),
    )
    expect(moved.value.result).toBe('updated')
    expect((await w.runtime.runPromise(pay(w.ctx, 'Erin', '1', 'erin-2'))).value.approval_reason).toBe('new_contact')
    // A rename alone changes no address and no lane.
    const renamed = await w.runtime.runPromise(
      contactUpdate(w.ctx, { contact: 'Erin', name: 'Erin K', aliases: ['ek'], idempotency_key: 'erin-renamed' }),
    )
    expect(renamed.value.contact).toMatchObject({ name: 'Erin K', aliases: ['ek'] })
  })
})

describe('contacts_search', () => {
  test('an empty query lists contacts by most recent payment first, never paid last by name', async () => {
    const w = await senderWorld()
    for (const [name, address] of [
      ['Zed', DAVE],
      ['Amy', ERIN],
      ['Bob', BOB],
    ] as const)
      await w.runtime.runPromise(
        createContact({ ownerId: OWNER, displayName: name, aliases: [], address, memo: null, readiness: 'usdc_ready' }),
      )
    await w.runtime.runPromise(
      write(
        sql("UPDATE contact_destinations SET last_paid_at = '2026-10-25T20:00:00.000Z' WHERE address = ?", DAVE),
        sql("UPDATE contact_destinations SET last_paid_at = '2026-10-25T21:00:00.000Z' WHERE address = ?", BOB),
      ),
    )
    const listed = await w.runtime.runPromise(contactsSearch(w.ctx, ''))
    expect(listed.value.contacts.map(contact => contact.name)).toEqual(['Bob', 'Zed', 'Amy'])
  })
})

describe('contact_add, contact_update, contact_remove', () => {
  test('idempotent; an address already saved is not added twice; a taken name is refused; remove forgets it', async () => {
    const w = await senderWorld()
    const first = await w.runtime.runPromise(contactAdd(w.ctx, { name: 'Dave', address: DAVE, idempotency_key: 'k1' }))
    const repeat = await w.runtime.runPromise(contactAdd(w.ctx, { name: 'Dave', address: DAVE, idempotency_key: 'k1' }))
    expect(repeat.value).toEqual(first.value)
    const twice = await w.runtime.runPromise(contactAdd(w.ctx, { name: 'David', address: DAVE, idempotency_key: 'k2' }))
    expect(twice.value.result).toBe('unchanged')
    const taken = await w.runtime.runPromise(
      Effect.flip(contactAdd(w.ctx, { name: 'dave', address: ERIN, idempotency_key: 'k3' })),
    )
    expect(taken.message).toContain('already exists')
    const otherTool = await w.runtime.runPromise(
      Effect.flip(contactRemove(w.ctx, { contact: 'Dave', idempotency_key: 'k1' })),
    )
    expect(otherTool.message).toContain('was used for contact_add')
    const removed = await w.runtime.runPromise(contactRemove(w.ctx, { contact: 'Dave', idempotency_key: 'k4' }))
    expect(removed.value.result).toBe('removed')
    const gone = await w.runtime.runPromise(Effect.flip(pay(w.ctx, 'Dave', '1', 'dave-gone')))
    expect(gone.message).toContain('No saved contact')
  })
})

describe('wallet_deposit_address, payments_list, connection_grant_update', () => {
  test('the deposit address once, watched; unavailable without a router', async () => {
    const w = await senderWorld()
    const shown = await w.runtime.runPromise(walletDepositAddress(w.ctx))
    expect(shown.value).toMatchObject({ status: 'active', account_status: 'active', received_total: '0.00' })
    expect(shown.value.address).toMatch(/^G[A-Z2-7]{55}$/u)
    expect(shown.sentence).toContain(shown.value.address ?? 'missing')
    const again = await w.runtime.runPromise(walletDepositAddress(w.ctx))
    expect(again.value.address).toBe(shown.value.address)
    expect(w.fixture.callsOf('createDepositAddress')).toHaveLength(1)

    const fixture = makeFixtureChain()
    const none = await senderWorld({ ...fixture, chain: { ...fixture.chain, depositsAvailable: false } })
    const unavailable = await none.runtime.runPromise(walletDepositAddress(none.ctx))
    expect(unavailable.value).toMatchObject({ status: 'unavailable', address: null })
  })

  test('payments_list: newest first, bounded, with receipts', async () => {
    const w = await senderWorld()
    await w.runtime.runPromise(
      createContact({
        ownerId: OWNER,
        displayName: 'Bob',
        aliases: [],
        address: BOB,
        memo: null,
        readiness: 'usdc_ready',
      }),
    )
    const a = await w.runtime.runPromise(pay(w.ctx, 'Bob', '1', 'a'))
    await w.runtime.runPromise(paymentExecute(w.ctx, a.value.payment_id))
    await w.runtime.runPromise(pay(w.ctx, 'Bob', '20', 'b'))
    const listed = await w.runtime.runPromise(paymentsList(w.ctx, {}))
    expect(listed.value.payments.map(payment => payment.amount)).toEqual(['20.00', '1.00'])
    expect(listed.value.payments[1]?.receipt?.explorer_url).toContain('stellar.expert')
    expect((await w.runtime.runPromise(paymentsList(w.ctx, { limit: 1 }))).value.payments).toHaveLength(1)
  })

  test('connection_grant_update returns the link; the passkey installs it and the grant moves to the new rule', async () => {
    const w = await senderWorld()
    const before = await w.runtime.runPromise(grantOfConnection(CONNECTION))
    const update = await w.runtime.runPromise(
      connectionGrantUpdate(w.ctx, { amount: '8', valid_for_hours: 48, idempotency_key: 'raise' }),
    )
    expect(update.value.url).toBe(`${ORIGIN}/approve/allowance/${CONNECTION}?amount=8.00&hours=48`)
    expect(update.sentence).toContain(update.value.url)
    const path = `/approve/allowance/${CONNECTION}`
    const page = await w.route('GET', `${path}?amount=8.00&hours=48`, undefined, `hm_owner=${w.token}`)
    expect(page.status).toBe(200)
    expect(page.text).toContain('allowance-approve')
    const prepared = await w.route('POST', `${path}/prepare`, { amount: '8.00', hours: 48 }, `hm_owner=${w.token}`)
    expect(prepared.status).toBe(200)
    const { pending_id, challenge } = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ pending_id: Schema.String, challenge: Schema.String })),
    )(prepared.text)
    const signed = await assertion(w.passkey, challenge)
    const installed = await w.route('POST', path, { pending_id, assertion: signed }, `hm_owner=${w.token}`)
    expect(installed.status).toBe(200)
    const after = await w.runtime.runPromise(grantOfConnection(CONNECTION))
    expect(after).toMatchObject({ total: toStroops('8'), spent: 0n, status: 'active', rule_status: 'installed' })
    expect(after?.rule_id).not.toBe(before?.rule_id)
    expect(after?.signer_key_ref).not.toBe(before?.signer_key_ref)
    // The old rule goes with one more passkey tap.
    const removal = await w.route('POST', `${path}/remove-old/prepare`, {}, `hm_owner=${w.token}`)
    expect(removal.status).toBe(200)
    const removalChallenge = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ challenge: Schema.String })),
    )(removal.text).challenge
    const removed = await w.route(
      'POST',
      `${path}/remove-old`,
      { assertion: await assertion(w.passkey, removalChallenge) },
      `hm_owner=${w.token}`,
    )
    expect(removed.status).toBe(200)
    expect(w.fixture.rules().find(rule => rule.ruleId === before?.rule_id)?.removed).toBe(true)
    // Payments now run under the new 8 USDC allowance.
    await w.runtime.runPromise(
      createContact({
        ownerId: OWNER,
        displayName: 'Bob',
        aliases: [],
        address: BOB,
        memo: null,
        readiness: 'usdc_ready',
      }),
    )
    const big = await w.runtime.runPromise(pay(w.ctx, 'Bob', '7', 'seven'))
    expect(big.value.lane).toBe('autonomous')
    expect((await w.runtime.runPromise(paymentExecute(w.ctx, big.value.payment_id))).value.status).toBe('confirmed')
  })
})

const assertion = async (passkey: SoftPasskey, challenge: string) => {
  const signed = await passkey.assertChallenge(challenge)
  return {
    credential_id: Base64Url.encode(passkey.credentialId),
    client_data_json: Base64Url.encode(signed.clientDataJSON),
    authenticator_data: Base64Url.encode(signed.authenticatorData),
    signature: Base64Url.encode(signed.signature),
  }
}
