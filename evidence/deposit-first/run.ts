/**
 * Deposit-first signup against a running stage on the real chain (testnet), end to end over HTTP:
 *
 *   bun evidence/deposit-first/run.ts [--base http://localhost:18960] [--usdc 3]
 *
 * 1. A software passkey creates a wallet with `deposit_first: true`: no deploy, no welcome USDC.
 * 2. The overview says `awaiting_deposit`; the planned C… has no contract instance onchain.
 * 3. GET /api/wallet/deposit-address creates the G…; the relayer's balance and sponsoring count before and after.
 * 4. An "exchange" (a fresh friendbot account) buys USDC on the testnet DEX and pays it to the G… in one path payment.
 * 5. The wallet's Durable Object sweeps it and deploys the account; the overview turns `active` with the balance.
 *
 * Writes evidence/deposit-first/<timestamp>.json. Testnet only; no secrets are read (the exchange key is fresh and
 * printed nowhere).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { SoftPasskey } from '../../packages/stellar/src/testing.ts'

const { Address, Asset, Horizon, Keypair, Networks, Operation, rpc, TransactionBuilder, xdr } = Stellar

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? (process.argv[at + 1] ?? fallback) : fallback
}
const BASE = arg('--base', 'http://localhost:18960')
const USDC_AMOUNT = arg('--usdc', '3')
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC = new Asset('USDC', ISSUER)
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
const soroban = new rpc.Server('https://soroban-testnet.stellar.org')
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const log: Array<Record<string, unknown>> = []
const step = (name: string, data: Record<string, unknown>) => {
  const entry = { at: new Date().toISOString(), step: name, ...data }
  log.push(entry)
  console.log(JSON.stringify(entry))
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let cookie = ''
const api = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie !== null) cookie = setCookie.split(';')[0] ?? ''
  const text = await response.text()
  let json: unknown = text
  try {
    json = JSON.parse(text)
  } catch {}
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`)
  return json
}

/** `value.a.b…` as a string ('' when absent): the replies are read, not trusted. */
const at = (value: unknown, ...path: ReadonlyArray<string | number>): string => {
  let current: unknown = value
  for (const key of path)
    current = typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined
  return typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean' ? String(current) : ''
}

const relayerState = async (address: string) => {
  const account = await horizon.loadAccount(address)
  const native = account.balances.find(b => b.asset_type === 'native')
  return {
    xlm: native?.balance ?? '0',
    num_sponsoring: account.num_sponsoring,
    subentries: account.subentry_count,
  }
}

const contractExists = async (contractId: string) => {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
  return (await soroban.getLedgerEntries(key)).entries.length > 0
}

const health = await api('GET', '/api/health')
const relayer = at(health, 'chain', 'relayers', 0, 'address')
step('health', { stage: at(health, 'stage'), release: at(health, 'release'), network: at(health, 'network'), relayer })
const relayerBefore = await relayerState(relayer)
step('relayer before', relayerBefore)

const origin = new URL(BASE).origin
const rpId = new URL(BASE).hostname
const options = await api('POST', '/api/wallets/options', { name: 'Deposit-first' })
const passkey = await SoftPasskey.create(at(options, 'rp_id') || rpId, origin)
const clientData = { type: 'webauthn.create', challenge: at(options, 'challenge'), origin, crossOrigin: false }
const t0 = Date.now()
const created = await api('POST', '/api/wallets', {
  name: 'Deposit-first',
  credential_id: b64url(passkey.credentialId),
  public_key: b64url(passkey.publicKey65),
  client_data_json: b64url(new TextEncoder().encode(JSON.stringify(clientData))),
  attestation_object: '',
  deposit_first: true,
})
const wallet = {
  id: at(created, 'wallet', 'id'),
  contract_id: at(created, 'wallet', 'contract_id'),
  deploy_tx: at(created, 'wallet', 'deploy_tx'),
  fund_tx: at(created, 'wallet', 'fund_tx'),
}
step('signup', { ms: Date.now() - t0, wallet_id: wallet.id, contract_id: wallet.contract_id, deploy_tx: wallet.deploy_tx, fund_tx: wallet.fund_tx })
const overview0 = await api('GET', '/api/overview')
step('overview after signup', {
  account_status: at(overview0, 'wallet', 'account_status'),
  usdc: at(overview0, 'balances', 'usdc'),
  contract_onchain: await contractExists(wallet.contract_id),
})

const t1 = Date.now()
const deposit = await api('GET', '/api/wallet/deposit-address')
step('deposit address', {
  ms: Date.now() - t1,
  address: at(deposit, 'address'),
  recipient: at(deposit, 'recipient'),
  expires_at: at(deposit, 'expires_at'),
  create_tx: `${EXPLORER}/tx/${at(deposit, 'create_tx')}`,
  register_tx: `${EXPLORER}/tx/${at(deposit, 'register_tx')}`,
  lock_tx: `${EXPLORER}/tx/${at(deposit, 'lock_tx')}`,
})
const relayerAfter = await relayerState(relayer)
step('relayer after the deposit address, before any USDC', {
  ...relayerAfter,
  xlm_spent: (Number(relayerBefore.xlm) - Number(relayerAfter.xlm)).toFixed(7),
  sponsoring_added: relayerAfter.num_sponsoring - relayerBefore.num_sponsoring,
  contract_onchain: await contractExists(wallet.contract_id),
})

// The exchange: a fresh friendbot account buys USDC on the testnet DEX and pays it to G in one path payment.
const exchange = Keypair.random()
await fetch(`https://friendbot.stellar.org/?addr=${exchange.publicKey()}`)
const source = await horizon.loadAccount(exchange.publicKey())
const pay = new TransactionBuilder(source, { fee: '1000', networkPassphrase: Networks.TESTNET })
  .addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: '1000',
      destination: at(deposit, 'address'),
      destAsset: USDC,
      destAmount: USDC_AMOUNT,
      path: [],
    }),
  )
  .setTimeout(60)
  .build()
pay.sign(exchange)
const paid = await horizon.submitTransaction(pay)
step('exchange pays the deposit address', {
  exchange: exchange.publicKey(),
  usdc: USDC_AMOUNT,
  tx: `${EXPLORER}/tx/${paid.hash}`,
})

const t2 = Date.now()
let overview = await api('GET', '/api/overview')
while (at(overview, 'wallet', 'account_status') !== 'active' || at(overview, 'balances', 'usdc') === '0') {
  if (Date.now() - t2 > 240_000) throw new Error('no activation within 4 minutes')
  await sleep(10_000)
  overview = await api('GET', '/api/overview')
}
const after = await api('GET', '/api/wallet/deposit-address')
step('activated', {
  ms_after_payment: Date.now() - t2,
  account_status: at(overview, 'wallet', 'account_status'),
  usdc: at(overview, 'balances', 'usdc'),
  deploy_tx: `${EXPLORER}/tx/${at(overview, 'wallet', 'deploy_tx')}`,
  sweep_tx: at(after, 'last_sweep_tx') === '' ? null : `${EXPLORER}/tx/${at(after, 'last_sweep_tx')}`,
  swept_total: at(after, 'swept_total'),
  contract: `${EXPLORER}/contract/${wallet.contract_id}`,
  contract_onchain: await contractExists(wallet.contract_id),
})
const file = join(import.meta.dir, `${new Date().toISOString().replace(/[:.]/gu, '-')}.json`)
writeFileSync(file, `${JSON.stringify({ base: BASE, steps: log }, null, 2)}\n`)
console.log(`wrote ${file}`)
