import { Effect, Layer, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach, describe, expect, test } from 'vitest'

import { WalletSummary } from '@hm/api'
import { SoftPasskey } from '@hm/stellar/testing'

import { makeApiHandler } from './app.ts'
import { claimLinkById } from './claims.ts'
import { pendingLinkApprovals } from './person-link.ts'
import { sql, write } from './rows.ts'
import type { AppServices } from './runtime.ts'
import { passkeyAnswer } from './sample/owner-pages.ts'
import { createOwnerWallet, createSession, renameWallet, walletById } from './store.ts'
import { ORIGIN, senderWorld, WALLET } from './test/sender.ts'
import { paymentPrepare } from './tools.ts'

const handlers: Array<ReturnType<typeof makeApiHandler>> = []
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(api => api.dispose()))
})
const Reply = Schema.Struct({ wallet: WalletSummary })
const Challenge = Schema.Struct({ challenge: Schema.String, allow_credentials: Schema.Array(Schema.String) })
const json = (text: string): unknown => JSON.parse(text)

const world = async () => {
  const w = await senderWorld()
  const api = makeApiHandler(Layer.succeedContext(await w.runtime.runPromise(Effect.context<AppServices>())))
  handlers.push(api)
  const call = (method: string, path: string, body?: unknown, token = w.token) =>
    api.handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: token === '' ? '' : `hm_owner=${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { ...w, api, call }
}

describe('wallet identity boundaries', () => {
  test('rename is session scoped and changes neither address nor passkey; validation stops blank names', async () => {
    const w = await world()
    const other = await w.newWallet()
    const original = await w.runtime.runPromise(walletById(WALLET))
    expect((await w.call('PATCH', '/api/wallet/name', { name: 'Travel' }, '')).status).toBe(401)
    for (const name of ['', '   ', 'x'.repeat(41)]) {
      expect((await w.call('PATCH', '/api/wallet/name', { name })).status).toBe(400)
      expect((await w.call('POST', '/api/wallets/options', { name }, '')).status).toBe(400)
    }
    const renamed = await w.call('PATCH', '/api/wallet/name', { name: '  Travel  ', id: other.wallet.id })
    expect(renamed.status).toBe(200)
    expect(Schema.decodeUnknownSync(Reply)(await renamed.json()).wallet).toMatchObject({
      name: 'Travel',
      contract_id: w.contractId,
    })
    expect(await w.runtime.runPromise(walletById(WALLET))).toEqual({ ...original, name: 'Travel' })
    expect((await w.runtime.runPromise(walletById(other.wallet.id)))?.name).toBe('Jan')
    for (const path of ['/api/session', '/api/overview']) {
      expect(Schema.decodeUnknownSync(Reply)(await (await w.call('GET', path)).json()).wallet.name).toBe('Travel')
    }
    expect(w.fixture.balanceOf(w.contractId)).toBe(300_000_000n)
  })

  test('filtered and discovery login both verify signatures and sign-out revokes the old session', async () => {
    const w = await world()
    const credential = Base64Url.encode(w.passkey.credentialId)
    const filtered = Schema.decodeUnknownSync(Challenge)(
      await (await w.call('POST', `/api/session/options?credential_id=${credential}`, {})).json(),
    )
    expect(filtered.allow_credentials).toEqual([credential])
    const discovery = Schema.decodeUnknownSync(Challenge)(
      await (await w.call('POST', '/api/session/options', {})).json(),
    )
    expect(discovery.allow_credentials).toEqual([])
    const signed = await w.runtime.runPromise(passkeyAnswer(w.passkey, filtered.challenge))
    const login = await w.call('POST', '/api/session', signed, '')
    expect(login.status).toBe(200)
    expect(Schema.decodeUnknownSync(Reply)(await login.json()).wallet.id).toBe(WALLET)
    expect((await w.call('POST', '/api/session/sign-out', {})).status).toBe(204)
    expect((await w.call('GET', '/api/session')).status).toBe(401)
  })

  test('two wrong wallets cannot prepare or install; reload and retry preserve the link until the right wallet approves', async () => {
    const w = await world()
    const original = await w.runtime.runPromise(walletById(WALLET))
    if (original === undefined) throw new Error('missing sender')
    await w.runtime.runPromise(renameWallet(original, 'kristjan0'))
    const prepared = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: 'new', recipient_name: 'Vlad', amount: '7', idempotency_key: 'identity' }),
    )
    const id = prepared.value.payment_id
    const key = Base64Url.encode(new Uint8Array(32).fill(9))
    const wrongPasskey = await SoftPasskey.create('wallet.test', ORIGIN)
    for (const [i, name] of ['Alexander', 'kristjan1'].entries()) {
      const wallet = await w.runtime.runPromise(
        createOwnerWallet({
          name,
          network: 'stellar:testnet',
          contractId: `C${String.fromCharCode(65 + i).repeat(55)}`,
          credentialId: `wrong-${i}`,
          publicKey: Base64Url.encode(wrongPasskey.publicKey65),
          deployTx: null,
          fundTx: null,
        }),
      )
      const token = await w.runtime.runPromise(createSession(wallet.owner_id))
      const page = await w.route('GET', `/approve/link/${id}`, undefined, `hm_owner=${token}`)
      expect(page.text).toContain(`You selected <strong>${name}</strong>`)
      expect(page.text).toContain('belongs to <strong>kristjan0</strong>')
      expect(page.text).toContain('Try another passkey')
      expect(page.text).not.toContain('data-testid="link-approve"')
      expect(
        (await w.route('POST', `/approve/link/${id}/prepare`, { public_key: key }, `hm_owner=${token}`)).status,
      ).toBe(400)
    }
    const page = await w.route('GET', `/approve/link/${id}`, undefined, `hm_owner=${w.token}`)
    const context = /<script type="application\/json" id="ctx">(.*?)<\/script>/su.exec(page.text)?.[1]
    expect(context && json(context)).toMatchObject({
      credential: Base64Url.encode(w.passkey.credentialId),
      walletId: WALLET,
    })
    const before = w.fixture.callsOf('installGrant').length
    const preparation = await w.route('POST', `/approve/link/${id}/prepare`, { public_key: key }, `hm_owner=${w.token}`)
    const challenge = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }))(
      json(preparation.text),
    ).challenge
    expect(w.fixture.callsOf('installGrant')).toHaveLength(before)
    const wrong = await w.runtime.runPromise(passkeyAnswer(wrongPasskey, challenge))
    expect((await w.route('POST', `/approve/link/${id}`, { assertion: wrong }, `hm_owner=${w.token}`)).status).toBe(401)
    expect((await w.runtime.runPromise(claimLinkById(id)))?.status).toBe('awaiting_nod')
    const pending = await (await w.call('GET', '/api/pending')).json()
    expect(pending).toEqual(
      expect.arrayContaining([expect.objectContaining({ intent_id: id, approve_url: `${ORIGIN}/approve/link/${id}` })]),
    )
    expect(w.fixture.callsOf('installGrant')).toHaveLength(before)
    const correct = await w.runtime.runPromise(passkeyAnswer(w.passkey, challenge))
    expect((await w.route('POST', `/approve/link/${id}`, { assertion: correct }, `hm_owner=${w.token}`)).status).toBe(
      200,
    )
    expect(w.fixture.callsOf('installGrant')).toHaveLength(before + 1)
    expect(await w.runtime.runPromise(pendingLinkApprovals(WALLET, ORIGIN))).toEqual([])
    expect(w.fixture.balanceOf(w.contractId)).toBe(300_000_000n)
  })

  test('expired links leave the inbox and cannot be approved; diagnostics accept only enumerated events', async () => {
    const w = await world()
    const made = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: 'new', recipient_name: 'Vlad', amount: '7', idempotency_key: 'expiry' }),
    )
    const id = made.value.payment_id
    await w.runtime.runPromise(
      write(sql("UPDATE claim_links SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?", id)),
    )
    expect(await w.runtime.runPromise(pendingLinkApprovals(WALLET, ORIGIN))).toEqual([])
    const page = await w.route('GET', `/approve/link/${id}`, undefined, `hm_owner=${w.token}`)
    expect(page.text).toContain('This link is expired.')
    expect(page.text).not.toContain('data-testid="link-approve"')
    expect(
      (await w.route('POST', `/approve/link/${id}/prepare`, { public_key: 'x' }, `hm_owner=${w.token}`)).status,
    ).toBe(400)
    expect((await w.call('POST', '/api/session/ceremony', { event: 'cancelled_or_timeout' })).status).toBe(204)
    expect((await w.call('POST', '/api/session/ceremony', { event: 'secret fragment here' })).status).toBe(400)
  })
})
