import { ManagedRuntime, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach, describe, expect, test } from 'vitest'

import { SoftPasskey } from '@hm/stellar/testing'

import { makeApiHandler } from './app.ts'
import type { NetworkShape } from './network.ts'
import { backfillNetwork, contactsOfOwner, createContact, walletById } from './store.ts'
import { testNetwork, testServices } from './test/layers.ts'
import { OWNER_ID, WALLET_ID, seedWallet } from './test/seed.ts'

/**
 * A wallet created on the mainnet stage said `stellar:testnet` (the column was hardcoded), so the SPA's header badge
 * read Testnet beside a Mainnet card. The row takes the stage's network at creation, /api reports the stage's network,
 * and existing rows are backfilled from the stage.
 */

const PUBNET: NetworkShape = {
  ...testNetwork,
  name: 'pubnet',
  caip: 'stellar:pubnet',
  label: 'Mainnet',
  explorerBase: 'https://stellar.expert/explorer/public',
  welcomeFunding: false,
}

const handlers: Array<ReturnType<typeof makeApiHandler>> = []
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(api => api.dispose()))
})

const Options = Schema.Struct({ challenge: Schema.String })
const Reply = Schema.Struct({ wallet: Schema.Struct({ id: Schema.String, network: Schema.String }) })

const post = (api: ReturnType<typeof makeApiHandler>, path: string, body: unknown, cookie = '') =>
  api.handler(
    new Request(`https://wallet.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  )

describe('the wallet network follows the stage', () => {
  test('a wallet created on a mainnet stage is stellar:pubnet in the reply, the session and the overview', async () => {
    const api = makeApiHandler(testServices(undefined, undefined, PUBNET))
    handlers.push(api)
    const options = Schema.decodeUnknownSync(Options)(
      await (await post(api, '/api/wallets/options', { name: 'Personal' })).json(),
    )
    const passkey = await SoftPasskey.create('wallet.test', 'https://wallet.test')
    const clientData = { type: 'webauthn.create', challenge: options.challenge, origin: 'https://wallet.test' }
    const created = await post(api, '/api/wallets', {
      name: 'Personal',
      credential_id: Base64Url.encode(passkey.credentialId),
      public_key: Base64Url.encode(passkey.publicKey65),
      client_data_json: Base64Url.encode(new TextEncoder().encode(JSON.stringify(clientData))),
      attestation_object: '',
    })
    expect(created.status).toBe(200)
    expect(Schema.decodeUnknownSync(Reply)(await created.json()).wallet.network).toBe('stellar:pubnet')
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    for (const path of ['/api/session', '/api/overview']) {
      const response = await api.handler(new Request(`https://wallet.test${path}`, { headers: { cookie } }))
      expect(response.status).toBe(200)
      expect(Schema.decodeUnknownSync(Reply)(await response.json()).wallet.network).toBe('stellar:pubnet')
    }
  })

  test('the backfill moves stored wallet and contact rows to the stage network; new contacts take the wallet’s', async () => {
    const runtime = ManagedRuntime.make(testServices(undefined, undefined, PUBNET))
    try {
      await runtime.runPromise(seedWallet())
      await runtime.runPromise(
        createContact({
          ownerId: OWNER_ID,
          displayName: 'Bob',
          aliases: [],
          address: 'GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          memo: null,
          readiness: 'usdc_ready',
        }),
      )
      expect((await runtime.runPromise(walletById(WALLET_ID)))?.network).toBe('stellar:testnet')
      await runtime.runPromise(backfillNetwork('stellar:pubnet'))
      expect((await runtime.runPromise(walletById(WALLET_ID)))?.network).toBe('stellar:pubnet')
      const contacts = await runtime.runPromise(contactsOfOwner(OWNER_ID))
      expect(contacts.flatMap(contact => contact.destinations.map(destination => destination.network))).toEqual([
        'stellar:pubnet',
      ])
      await runtime.runPromise(
        createContact({
          ownerId: OWNER_ID,
          displayName: 'Carol',
          aliases: [],
          address: 'GCAROLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          memo: null,
          readiness: 'trustline_required',
        }),
      )
      const after = await runtime.runPromise(contactsOfOwner(OWNER_ID))
      expect(after.flatMap(contact => contact.destinations.map(destination => destination.network))).toEqual([
        'stellar:pubnet',
        'stellar:pubnet',
      ])
    } finally {
      await runtime.dispose()
    }
  })
})
