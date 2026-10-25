import { Effect, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { describe, expect, test } from 'vitest'

import { Chain, toStroops } from '@hm/protocol'
import type { SoftPasskey } from '@hm/stellar/testing'

import { claimLinkById } from './claims.ts'
import { activationOf } from './deposit.ts'
import { linksOfWallet } from './person-link.ts'
import { sql, write } from './rows.ts'
import { receiptsOfWallet } from './store.ts'
import { ORIGIN, senderWorld, WALLET } from './test/sender.ts'
import { paymentPrepare, paymentStatus } from './tools.ts'

/**
 * Person links (an allowance for a person): past the AI app's allowance, a claim link is a rule on the sender's account
 * for exactly the amount, signed by a key made in the sender's browser that only the link carries. The recipient's
 * browser signs the transfer; Nod relays it. Here the "browsers" are WebCrypto Ed25519 keys in the test.
 */

const b64 = (bytes: ArrayBuffer | Uint8Array) => Base64Url.encode(new Uint8Array(bytes))
const fromB64 = (text: string) => {
  const decoded = Base64Url.decode(text)
  if (decoded._tag !== 'Success') throw new Error('bad base64url')
  return new Uint8Array(decoded.success)
}

/** The sender's browser: an Ed25519 link key (its public half goes to Nod, the secret stays here). */
const linkKey = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  if (!('privateKey' in pair)) throw new Error('no key pair')
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  if (!(raw instanceof ArrayBuffer)) throw new Error('raw export did not return bytes')
  const publicKey = b64(raw)
  const sign = async (digest: string) =>
    b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, fromB64(digest)))
  return { publicKey, sign }
}

const assertion = async (passkey: SoftPasskey, challenge: string) => {
  const signed = await passkey.assertChallenge(challenge)
  return {
    credential_id: Base64Url.encode(passkey.credentialId),
    client_data_json: Base64Url.encode(signed.clientDataJSON),
    authenticator_data: Base64Url.encode(signed.authenticatorData),
    signature: Base64Url.encode(signed.signature),
  }
}

const Challenge = Schema.fromJsonString(Schema.Struct({ challenge: Schema.String }))
const Digest = Schema.fromJsonString(Schema.Struct({ digest: Schema.String, to: Schema.String }))
const Paid = Schema.fromJsonString(Schema.Struct({ status: Schema.Literal('paid'), tx: Schema.String }))

/** A person link for Jan, approved by the sender's passkey: the rule is on the account, the key in "the link". */
const approvedLink = async (w: Awaited<ReturnType<typeof senderWorld>>, amount: string, key: string) => {
  const made = await w.runtime.runPromise(
    paymentPrepare(w.ctx, { recipient: 'new', recipient_name: 'Jan', amount, reason: 'lunch', idempotency_key: key }),
  )
  const id = made.value.payment_id
  const cookie = `hm_owner=${w.token}`
  const k = await linkKey()
  const prepared = await w.route('POST', `/approve/link/${id}/prepare`, { public_key: k.publicKey }, cookie)
  expect(prepared.status).toBe(200)
  const { challenge } = Schema.decodeUnknownSync(Challenge)(prepared.text)
  const installed = await w.route(
    'POST',
    `/approve/link/${id}`,
    { assertion: await assertion(w.passkey, challenge) },
    cookie,
  )
  expect(installed.status).toBe(200)
  return { id, made, k }
}

describe('person links', () => {
  test('past the allowance, payment_prepare "new" waits for the nod with the approval page and no claim_url', async () => {
    const w = await senderWorld()
    const inside = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: 'new', recipient_name: 'Mia', amount: '1', idempotency_key: 'mia' }),
    )
    expect(inside.value).toMatchObject({ outcome: 'claim_link', lane: 'autonomous' })
    const past = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: 'new', recipient_name: 'Jan', amount: '7', idempotency_key: 'jan' }),
    )
    expect(past.value).toMatchObject({
      outcome: 'person_link',
      status: 'awaiting_approval',
      lane: 'owner',
      approval_reason: 'over_allowance',
      approval_url: `${ORIGIN}/approve/link/${past.value.payment_id}`,
      claim_url: null,
    })
    expect(past.sentence).toContain('nothing leaves their wallet until Jan claims it')
    const page = await w.route('GET', `/approve/link/${past.value.payment_id}`, undefined, `hm_owner=${w.token}`)
    expect(page.text).toContain('link-approve')
    // A v2 claim of a person link is refused; its own endpoints say it is not approved yet.
    expect(
      (await w.route('POST', `/claim/${past.value.payment_id}/destination`, { kind: 'address', address: 'G' })).status,
    ).toBe(400)
    expect((await w.route('POST', `/claim/${past.value.payment_id}/prepare`, { kind: 'wallet' })).status).toBe(404)
  })

  test('the nod installs a rule for exactly the amount; nothing moves until Jan claims; Jan signs in the browser', async () => {
    const w = await senderWorld()
    const { id, k } = await approvedLink(w, '7', 'jan-7')
    const link = await w.runtime.runPromise(claimLinkById(id))
    expect(link).toMatchObject({ status: 'open', signer_public_key: k.publicKey })
    const rule = w.fixture.rules().find(candidate => candidate.ruleId === link?.rule_id)
    expect(rule).toMatchObject({ signer: k.publicKey, limit: toStroops('7'), spent: 0n })
    const approved = await w.runtime.runPromise(paymentStatus(w.ctx, id))
    expect(approved.value).toMatchObject({ status: 'approved', claim_url: null })
    expect(approved.sentence).toContain('neither Nod nor this app sees it')
    expect(w.fixture.callsOf('finalizeLinkTransfer')).toHaveLength(0)

    const jan = await w.newWallet()
    const janCookie = `hm_owner=${jan.token}`
    const page = await w.route('GET', `/claim/${id}`)
    expect(page.text).toContain('claim-new-wallet')
    expect(page.text).toContain('#k=')
    const prepared = await w.route('POST', `/claim/${id}/prepare`, { kind: 'wallet', new: true }, janCookie)
    expect(prepared.status).toBe(200)
    const { digest, to } = Schema.decodeUnknownSync(Digest)(prepared.text)
    expect(to).toBe(jan.wallet.contract_id)
    const signed = await w.route('POST', `/claim/${id}/sign`, { signature: await k.sign(digest) })
    expect(signed.status).toBe(200)
    const paid = Schema.decodeUnknownSync(Paid)(signed.text)
    expect(w.fixture.balanceOf(jan.wallet.contract_id)).toBe(toStroops('7'))
    expect((await w.runtime.runPromise(activationOf(jan.wallet.id)))?.status).toBe('active')

    const status = await w.runtime.runPromise(paymentStatus(w.ctx, id))
    expect(status.value).toMatchObject({ status: 'confirmed', lane: 'owner' })
    expect(status.value.receipt?.tx_hash).toBe(paid.tx)
    const receipts = await w.runtime.runPromise(receiptsOfWallet(WALLET, 5))
    expect(receipts[0]).toMatchObject({ tx_hash: paid.tx, recipient_name: 'Jan', amount: toStroops('7') })
    const links = await w.runtime.runPromise(linksOfWallet(WALLET, ORIGIN))
    expect(links[0]).toMatchObject({ id, status: 'paid', tx_hash: paid.tx, revoke_url: null })

    // The same link a second time: Nod refuses, and the rule itself has nothing left.
    expect((await w.route('POST', `/claim/${id}/prepare`, { kind: 'wallet' }, janCookie)).status).toBe(409)
    expect((await w.route('POST', `/claim/${id}/sign`, { signature: await k.sign(digest) })).status).toBe(409)
    const again = await w.runtime.runPromise(
      Effect.flip(
        Chain.use(chain =>
          Effect.flatMap(
            chain.prepareLinkTransfer(
              w.contractId,
              link?.rule_id ?? 0,
              fromB64(k.publicKey),
              jan.wallet.contract_id,
              1n,
            ),
            next =>
              Effect.flatMap(
                Effect.promise(() => k.sign(next.digest)),
                sig => chain.finalizeLinkTransfer(next, fromB64(sig)),
              ),
          ),
        ),
      ),
    )
    expect(again.kind).toBe('limit_exhausted')
  })

  test('the amount boundary: exactly the amount passes, one stroop more is refused, nothing moves', async () => {
    const w = await senderWorld()
    const { id, k } = await approvedLink(w, '7', 'edge')
    const link = await w.runtime.runPromise(claimLinkById(id))
    const transfer = (amount: bigint) =>
      w.runtime.runPromise(
        Chain.use(chain =>
          Effect.flatMap(
            chain.prepareLinkTransfer(
              w.contractId,
              link?.rule_id ?? 0,
              fromB64(k.publicKey),
              'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              amount,
            ),
            next =>
              Effect.flatMap(
                Effect.promise(() => k.sign(next.digest)),
                sig => chain.finalizeLinkTransfer(next, fromB64(sig)),
              ),
          ),
        ).pipe(Effect.result),
      )
    const over = await transfer(toStroops('7') + 1n)
    expect(over._tag === 'Failure' ? over.failure.kind : 'paid').toBe('limit_exhausted')
    expect(w.fixture.balanceOf('GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(0n)
    const exact = await transfer(toStroops('7'))
    expect(exact._tag).toBe('Success')
    expect(w.fixture.balanceOf('GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(toStroops('7'))
  })

  test('a signature by another key is refused; the sender takes an open link back; an expired one pays nothing', async () => {
    const w = await senderWorld()
    const { id } = await approvedLink(w, '7', 'wrong-key')
    const prepared = await w.route('POST', `/claim/${id}/prepare`, {
      kind: 'address',
      address: 'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    const { digest } = Schema.decodeUnknownSync(Digest)(prepared.text)
    const stranger = await linkKey()
    expect((await w.route('POST', `/claim/${id}/sign`, { signature: await stranger.sign(digest) })).status).toBe(502)
    expect(w.fixture.balanceOf('GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(0n)

    const second = await approvedLink(w, '6', 'revoke-me')
    const cookie = `hm_owner=${w.token}`
    const removal = await w.route('POST', `/approve/revoke-link/${second.id}/prepare`, {}, cookie)
    const { challenge } = Schema.decodeUnknownSync(Challenge)(removal.text)
    const removed = await w.route(
      'POST',
      `/approve/revoke-link/${second.id}`,
      { assertion: await assertion(w.passkey, challenge) },
      cookie,
    )
    expect(removed.status).toBe(200)
    const revokedRule = (await w.runtime.runPromise(claimLinkById(second.id)))?.rule_id
    expect(w.fixture.rules().find(rule => rule.ruleId === revokedRule)?.removed).toBe(true)
    expect(
      (
        await w.route('POST', `/claim/${second.id}/prepare`, {
          kind: 'address',
          address: 'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        })
      ).status,
    ).toBe(410)
    expect((await w.runtime.runPromise(paymentStatus(w.ctx, second.id))).value.status).toBe('failed')
    const links = await w.runtime.runPromise(linksOfWallet(WALLET, ORIGIN))
    expect(links.find(row => row.id === second.id)).toMatchObject({ status: 'revoked', revoke_url: null })
    expect(links.find(row => row.id === id)?.revoke_url).toBe(`${ORIGIN}/approve/revoke-link/${id}`)

    const third = await approvedLink(w, '5.50', 'lapses')
    await w.runtime.runPromise(
      write(sql("UPDATE claim_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", third.id)),
    )
    expect(
      (
        await w.route('POST', `/claim/${third.id}/prepare`, {
          kind: 'address',
          address: 'GDAVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        })
      ).status,
    ).toBe(410)
    expect((await w.runtime.runPromise(paymentStatus(w.ctx, third.id))).value.status).toBe('expired')
  })
})
