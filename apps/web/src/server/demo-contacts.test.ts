import { Effect, Layer, Option, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach, describe, expect, test } from 'vitest'

import { makeFixtureChain } from '@hm/protocol'
import { SoftPasskey } from '@hm/stellar/testing'

import { makeApiHandler } from './app.ts'
import type { NetworkShape } from './network.ts'
import { testNetwork, testServices } from './test/layers.ts'
import { WalletSettings } from './wallet-settings.ts'

/**
 * On mainnet every stranger started with Nod's own Alice, Bob and Carol, so "pay Bob" paid our seed account. New wallets
 * get the demo contacts on testnet (the judge path) and on mainnet only with SEED_DEMO_CONTACTS=true (the recording
 * wallet); otherwise they start empty (K5).
 */

const ORIGIN = 'https://wallet.test'
const PUBNET: NetworkShape = {
  ...testNetwork,
  name: 'pubnet',
  caip: 'stellar:pubnet',
  label: 'Mainnet',
  explorerBase: 'https://stellar.expert/explorer/public',
  welcomeFunding: false,
}
const DEMO = [
  { name: 'Alice', address: 'CALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', trustline_required: false },
  { name: 'Bob', address: 'GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', trustline_required: false },
]

const handlers: Array<ReturnType<typeof makeApiHandler>> = []
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(api => api.dispose()))
})

const Options = Schema.Struct({ challenge: Schema.String })
const Contacts = Schema.Array(Schema.Struct({ display_name: Schema.String }))

/** A new wallet through POST /api/wallets on `network`; the names of the contacts it starts with. */
const contactsOfNewWallet = async (network: NetworkShape, seedDemoContacts?: boolean) => {
  const settings = Layer.succeed(WalletSettings, {
    stage: 'test',
    chain: 'fixture',
    rpId: Option.some('wallet.test'),
    origin: Option.some(ORIGIN),
    welcomeUsdc: 0n,
    demoContacts: DEMO,
    ...(seedDemoContacts === undefined ? {} : { seedDemoContacts }),
  })
  const api = makeApiHandler(Layer.merge(testServices(makeFixtureChain(), undefined, network), settings))
  handlers.push(api)
  const post = (path: string, body: unknown) =>
    api.handler(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  const options = Schema.decodeUnknownSync(Options)(await (await post('/api/wallets/options', { name: 'P' })).json())
  const passkey = await SoftPasskey.create('wallet.test', ORIGIN)
  const clientData = { type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN }
  const created = await post('/api/wallets', {
    name: 'Personal',
    credential_id: Base64Url.encode(passkey.credentialId),
    public_key: Base64Url.encode(passkey.publicKey65),
    client_data_json: Base64Url.encode(new TextEncoder().encode(JSON.stringify(clientData))),
    attestation_object: '',
  })
  expect(created.status).toBe(200)
  const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const listed = await api.handler(new Request(`${ORIGIN}/api/contacts`, { headers: { cookie } }))
  expect(listed.status).toBe(200)
  return Schema.decodeUnknownSync(Contacts)(await listed.json()).map(contact => contact.display_name)
}

const seedSetting = (bindings: Record<string, string>) =>
  Effect.runPromise(
    WalletSettings.use(settings => Effect.succeed(settings.seedDemoContacts)).pipe(
      Effect.provide(WalletSettings.fromBindings(bindings)),
    ),
  )

describe('demo contacts only where they belong', () => {
  test('testnet: a new wallet starts with the demo contacts', async () => {
    expect(await contactsOfNewWallet(testNetwork)).toEqual(['Alice', 'Bob'])
  })

  test('mainnet: a stranger’s new wallet starts empty', async () => {
    expect(await contactsOfNewWallet(PUBNET)).toEqual([])
  })

  test('mainnet with SEED_DEMO_CONTACTS=true (the recording wallet): the demo contacts', async () => {
    expect(await contactsOfNewWallet(PUBNET, true)).toEqual(['Alice', 'Bob'])
  })

  test('testnet with SEED_DEMO_CONTACTS=false: empty', async () => {
    expect(await contactsOfNewWallet(testNetwork, false)).toEqual([])
  })

  test('SEED_DEMO_CONTACTS: unset leaves the network to decide; true and false are read as such', async () => {
    expect(await seedSetting({})).toBeUndefined()
    expect(await seedSetting({ SEED_DEMO_CONTACTS: 'true' })).toBe(true)
    expect(await seedSetting({ SEED_DEMO_CONTACTS: 'false' })).toBe(false)
  })
})
