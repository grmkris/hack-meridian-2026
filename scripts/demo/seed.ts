import { writeFileSync } from 'node:fs'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { buyUsdc, classicBalances, ensureTrustline, friendbot, invoke, sacBalances, submit } from './lib/chain.ts'
import {
  SEEDS_FILE,
  SELLER_URL,
  USDC_ISSUER,
  USDC_SAC,
  envValue,
  explorerAddress,
  hasKey,
  key,
  usdc,
  writeEnv,
  type Role,
} from './lib/env.ts'

/**
 * Seeds the demo's testnet accounts (idempotent; run again to top up). Secrets go to scripts/demo/.env, public ids
 * to scripts/demo/seeds.json, and a table of public keys and balances to stdout.
 *
 *   bun scripts/demo/seed.ts                     everything
 *   bun scripts/demo/seed.ts --only SELLER,BUYER a subset of roles (ALICE is the smart account)
 *   bun scripts/demo/seed.ts --treasury 300      USDC target for the treasury (default 300)
 *   bun scripts/demo/seed.ts --table             print the table only
 *
 * RELAYER   classic G, ≥ 500 XLM (friendbot gives 10,000; merged friendbot accounts top it up): source + fee payer
 * TREASURY  classic G with a USDC trustline and the demo's USDC (bought on the testnet DEX): auto-funds new wallets
 * SELLER    classic G with a USDC trustline: payTo of apps/seller
 * BUYER     classic G with a little USDC: pays the seller directly (scripts/demo/pay.ts, probe)
 * ALICE     OpenZeppelin smart account (C…) with an Ed25519 owner (ALICE_OWNER, never funded); receives USDC
 * BOB       classic G with a USDC trustline: "USDC ready"
 * CAROL     classic G with XLM and NO USDC trustline: the claim-link recipient
 */
const ACCOUNT_WASM_HASH = '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a'
const ED25519_VERIFIER = 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4'
const RELAYER_MIN_XLM = 500

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const only = flag('--only')?.split(',')
const wants = (role: string) => only === undefined || only.includes(role)
const treasuryTarget = Number(flag('--treasury') ?? '300')
const tableOnly = args.includes('--table')

const NOTES: Record<string, string> = {
  RELAYER: 'tx source + fee payer (RELAYER_SECRET)',
  TREASURY: 'auto-funds new wallets (TREASURY_SECRET)',
  SELLER: 'apps/seller payTo',
  BUYER: 'pays the seller directly',
  ALICE: 'smart account, Ed25519 owner',
  BOB: 'USDC ready',
  CAROL: 'no USDC trustline (claim link)',
}

async function deployAlice(relayer: Stellar.Keypair): Promise<string> {
  const known = envValue('ALICE_CONTRACT_ID')
  if (known !== undefined) return known
  const owner = key('ALICE_OWNER')
  const signer = Stellar.xdr.ScVal.scvVec([
    Stellar.xdr.ScVal.scvSymbol('External'),
    new Stellar.Address(ED25519_VERIFIER).toScVal(),
    Stellar.xdr.ScVal.scvBytes(Buffer.from(owner.rawPublicKey())),
  ])
  const deployed = await invoke(
    relayer,
    Stellar.Operation.createCustomContract({
      address: new Stellar.Address(relayer.publicKey()),
      wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      constructorArgs: [Stellar.xdr.ScVal.scvVec([signer]), Stellar.xdr.ScVal.scvMap([])],
    }),
    'deploy ALICE smart account',
  )
  const contractId = String(deployed.returnValue)
  if (!contractId.startsWith('C')) throw new Error(`deploy returned ${contractId}`)
  writeEnv('ALICE_CONTRACT_ID', contractId)
  return contractId
}

/** Tops the relayer up by merging fresh friendbot accounts into it (each brings ~10,000 XLM). */
async function topUpRelayer(relayer: Stellar.Keypair) {
  for (let round = 0; round < 3; round++) {
    const xlm = Number((await classicBalances(relayer.publicKey()))?.xlm ?? '0')
    if (xlm >= RELAYER_MIN_XLM) return
    const donor = Stellar.Keypair.random()
    await friendbot(donor.publicKey())
    await submit(
      donor,
      [Stellar.Operation.accountMerge({ destination: relayer.publicKey() })],
      `merge friendbot donor ${donor.publicKey().slice(0, 6)}… into RELAYER`,
    )
  }
}

async function seed() {
  const relayer = key('RELAYER')
  const classic: Array<Role> = ['RELAYER', 'TREASURY', 'SELLER', 'BUYER', 'BOB', 'CAROL']
  for (const role of classic) {
    if (!wants(role)) continue
    const state = await friendbot(key(role).publicKey())
    if (state === 'funded') console.log(`friendbot funded ${role}`)
  }
  if (wants('RELAYER')) await topUpRelayer(relayer)
  for (const role of ['TREASURY', 'SELLER', 'BUYER', 'BOB'] as const)
    if (wants(role)) await ensureTrustline(key(role), role)
  if (wants('CAROL') && (await classicBalances(key('CAROL').publicKey()))?.trustline === true)
    console.log('WARNING: CAROL has a USDC trustline; the claim-link beat needs a fresh CAROL (delete CAROL_SECRET)')
  if (wants('TREASURY')) {
    const have = Number((await classicBalances(key('TREASURY').publicKey()))?.usdc ?? '0')
    const need = treasuryTarget - have
    if (need >= 1) await buyUsdc(key('TREASURY'), need.toFixed(7), String(Math.ceil(need * 12)), 'TREASURY')
  }
  if (wants('BUYER')) {
    const have = Number((await classicBalances(key('BUYER').publicKey()))?.usdc ?? '0')
    if (have < 0.5) await buyUsdc(key('BUYER'), '2', '40', 'BUYER')
  }
  if (wants('ALICE')) await deployAlice(relayer)
}

async function table() {
  const relayer = key('RELAYER', false).publicKey()
  const rows: Array<{ role: string; address: string; xlm: string; usdc: string; note: string }> = []
  const accounts: Record<string, { address: string; kind: 'classic' | 'smart_account'; note: string }> = {}
  for (const role of ['RELAYER', 'TREASURY', 'SELLER', 'BUYER', 'BOB', 'CAROL'] as const) {
    if (!hasKey(role)) {
      rows.push({ role, address: '(not seeded)', xlm: '-', usdc: '-', note: NOTES[role] ?? '' })
      continue
    }
    const address = key(role, false).publicKey()
    const b = await classicBalances(address)
    rows.push({
      role,
      address,
      xlm: b === undefined ? 'missing' : Number(b.xlm).toFixed(2),
      usdc: b === undefined ? '-' : b.usdc === null ? 'no trustline' : Number(b.usdc).toFixed(2),
      note: NOTES[role] ?? '',
    })
    accounts[role.toLowerCase()] = { address, kind: 'classic', note: NOTES[role] ?? '' }
  }
  const alice = envValue('ALICE_CONTRACT_ID')
  if (alice !== undefined) {
    const b = await sacBalances(relayer, alice)
    rows.push({ role: 'ALICE', address: alice, xlm: usdc(b.xlm), usdc: usdc(b.usdc), note: NOTES['ALICE'] ?? '' })
    accounts['alice'] = { address: alice, kind: 'smart_account', note: NOTES['ALICE'] ?? '' }
    accounts['alice_owner'] = {
      address: key('ALICE_OWNER', false).publicKey(),
      kind: 'classic',
      note: "Alice's Ed25519 owner key (rule 0); never funded",
    }
  }
  const seeds = {
    network: 'stellar:testnet',
    updated_at: new Date().toISOString(),
    usdc: { sac: USDC_SAC, issuer: USDC_ISSUER },
    seller: { url: SELLER_URL, pay_to: accounts['seller']?.address, price: '0.10 USDC' },
    contacts: {
      Alice: { address: alice ?? null, expected_readiness: 'usdc_ready (contract)' },
      Bob: { address: accounts['bob']?.address, expected_readiness: 'usdc_ready' },
      Carol: { address: accounts['carol']?.address, expected_readiness: 'trustline_required' },
    },
    accounts,
    explorer: Object.fromEntries(Object.entries(accounts).map(([role, a]) => [role, explorerAddress(a.address)])),
  }
  writeFileSync(SEEDS_FILE, `${JSON.stringify(seeds, null, 2)}\n`)
  console.log(
    `\n| role     | public key                                                 |        XLM | USDC         | note`,
  )
  console.log(
    `| -------- | ---------------------------------------------------------- | ---------: | ------------ | ----`,
  )
  for (const r of rows)
    console.log(
      `| ${r.role.padEnd(8)} | ${r.address.padEnd(58)} | ${r.xlm.padStart(10)} | ${r.usdc.padEnd(12)} | ${r.note}`,
    )
  console.log(`\nwrote ${SEEDS_FILE}`)
}

if (!tableOnly) await seed()
await table()
