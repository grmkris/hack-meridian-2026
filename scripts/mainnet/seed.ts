import { writeFileSync } from 'node:fs'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { externalSigner } from '../../packages/stellar/src/scval.ts'
import {
  FILES,
  NET,
  ROLE_LIST,
  SALTS,
  STROOPS,
  USDC,
  accountState,
  aliceId,
  announce,
  args,
  classicOps,
  contractExists,
  explorerAddress,
  flag,
  keypair,
  publicKey,
  saltOf,
  setEnvLine,
  sorobanOp,
  xlm,
  type Role,
  type Spend,
} from './lib.ts'

/**
 * M5, plus the trustlines that must exist before USDC arrives: the mainnet demo accounts.
 *
 *   bun scripts/mainnet/seed.ts --network pubnet --dry-run
 *   HM26_MAINNET_GO=yes bun scripts/mainnet/seed.ts --network pubnet [--only trustlines,alice,contacts] [--write-env]
 *     --roles treasury,bob   limit the trustlines step to these accounts (default treasury, seller, bob)
 *
 * trustlines  USDC `changeTrust` (each account its own source and fee payer; 0.5 XLM reserve) for the treasury (run
 *             right after its XLM lands, before Kristjan sends USDC), the seller payTo (before M4) and Bob (usdc_ready)
 * alice       an OpenZeppelin smart account from WASM 1b5f4534… with rule 0 = External(pubnet Ed25519 verifier, relayer
 *             A's key): relayer A deploys it the way @hm/stellar's deployAccount does (createCustomContract, relayer as
 *             source, no policies) and stands in as its owner, as ALICE_OWNER did on testnet. Fixed salt: the id is
 *             known in advance and a second run skips the deploy
 * contacts    checks Carol (funded, ≥ 1.5 XLM, no trustline), Bob and Alice; writes scripts/demo/seeds.pubnet.json
 *             (public) and prints DEMO_CONTACTS for apps/web/.env.mainnet (`--write-env` sets it there)
 */
if (flag('--network') !== 'pubnet') {
  console.error('say --network pubnet explicitly: this seeds mainnet accounts')
  process.exit(2)
}
const only = flag('--only')?.split(',')
const wants = (step: 'trustlines' | 'alice' | 'contacts') => only === undefined || only.includes(step)

const TRUSTLINE_ROLES: ReadonlyArray<Role> = ['treasury', 'seller', 'bob']
const rolesArg = flag('--roles')?.split(',')
const trustRoles = TRUSTLINE_ROLES.filter(role => rolesArg === undefined || rolesArg.includes(role))
if (rolesArg !== undefined && rolesArg.some(role => !TRUSTLINE_ROLES.some(known => known === role)))
  throw new Error(`--roles takes ${TRUSTLINE_ROLES.join(', ')}`)
const RESERVE = 5_000_000n
const CAROL_MIN = 15_000_000n

const states = Object.fromEntries(
  await Promise.all(ROLE_LIST.map(async role => [role, await accountState(publicKey(role))] as const)),
)
const state = (role: Role) => {
  const s = states[role]
  if (s === undefined) throw new Error(`no state for ${role}`)
  return s
}
const alice = aliceId()
const aliceThere = await contractExists(alice)

const needTrust = wants('trustlines') ? trustRoles.filter(role => state(role).usdc === null) : []
const spends: Array<Spend> = [
  ...needTrust.map(role => ({ what: `${role} USDC trustline (0.5 XLM reserve + fee)`, payer: role, xlm: 0.501 })),
  ...(wants('alice') && !aliceThere
    ? [{ what: 'deploy Alice smart account (simulated ≈ 0.18 XLM on 25 Oct)', payer: 'relayer A', xlm: 0.25 }]
    : []),
]
const mode = announce('M5 seeds', spends)

for (const role of needTrust) {
  const s = state(role)
  if (s.exists && s.xlm < s.reserve + RESERVE + 100_000n)
    console.log(`  WARNING ${role}: ${xlm(s.xlm)} XLM cannot cover another 0.5 XLM reserve`)
  await classicOps({
    label: `${role} USDC trustline`,
    source: keypair(role),
    ops: [Stellar.Operation.changeTrust({ asset: USDC })],
    submit: mode === 'submit',
  })
}

if (wants('alice')) {
  if (aliceThere) console.log(`  Alice ${alice} exists`)
  else {
    const owner = keypair('relayerA')
    const deployed = await sorobanOp({
      label: 'deploy Alice smart account',
      source: owner.publicKey(),
      op: Stellar.Operation.createCustomContract({
        address: new Stellar.Address(owner.publicKey()),
        wasmHash: Buffer.from(NET.contracts.accountWasmHash, 'hex'),
        salt: saltOf(SALTS.alice),
        constructorArgs: [
          Stellar.xdr.ScVal.scvVec([externalSigner(NET.contracts.ed25519Verifier, owner.rawPublicKey())]),
          Stellar.xdr.ScVal.scvMap([]),
        ],
      }),
      ceilingStroops: STROOPS / 2n,
      signer: mode === 'submit' ? owner : undefined,
    })
    const returned =
      deployed.returnValue === undefined ? undefined : Stellar.Address.fromScVal(deployed.returnValue).toString()
    if (returned !== alice) throw new Error(`the deploy returns ${returned ?? 'nothing'}, not the precomputed ${alice}`)
  }
}

if (wants('contacts')) {
  const carol = await accountState(publicKey('carol'))
  const bob = await accountState(publicKey('bob'))
  const problems = [
    ...(!carol.exists ? ['Carol is not funded'] : []),
    ...(carol.exists && carol.xlm < CAROL_MIN
      ? [`Carol holds ${xlm(carol.xlm)} XLM; the claim's trust needs 1.5`]
      : []),
    ...(carol.usdc !== null ? ['Carol has a USDC trustline; the claim-link beat needs a fresh Carol'] : []),
    ...(bob.usdc === null ? ['Bob has no USDC trustline yet (--only trustlines)'] : []),
    ...(!(await contractExists(alice)) ? ['Alice is not deployed yet (--only alice)'] : []),
  ]
  for (const p of problems) console.log(`  ${mode === 'submit' ? 'NOT READY' : 'pending'}: ${p}`)
  const contacts = [
    { name: 'Alice', address: alice, trustline_required: false },
    { name: 'Bob', address: bob.address, trustline_required: false },
    { name: 'Carol', address: carol.address, trustline_required: true },
  ]
  if (mode === 'submit') {
    const accounts = Object.fromEntries(
      ROLE_LIST.map(role => [role, { address: publicKey(role), explorer: explorerAddress(publicKey(role)) }]),
    )
    const seeds = {
      network: NET.x402Network,
      updated_at: new Date().toISOString(),
      usdc: { sac: NET.contracts.usdcSac, issuer: NET.usdcIssuer },
      seller: {
        url: 'https://hm26-seller-mainnet.kristjan-grm11775.workers.dev',
        pay_to: publicKey('seller'),
        price: '0.10 USDC',
      },
      // Same shape as seeds.json, so apps/web/alchemy.run.ts's demoContacts() can read it for the mainnet stage.
      contacts: {
        Alice: { address: alice, expected_readiness: 'usdc_ready (contract)' },
        Bob: { address: bob.address, expected_readiness: 'usdc_ready' },
        Carol: { address: carol.address, expected_readiness: 'trustline_required' },
      },
      accounts: {
        ...accounts,
        alice: {
          address: alice,
          explorer: explorerAddress(alice),
          note: "smart account; rule 0 = relayer A's Ed25519 key",
        },
      },
    }
    writeFileSync(FILES.seeds, `${JSON.stringify(seeds, null, 2)}\n`)
    console.log(`  wrote ${FILES.seeds}`)
  }
  console.log(`\nDEMO_CONTACTS=${JSON.stringify(contacts)}`)
  if (args.includes('--write-env') && mode === 'submit' && problems.length === 0) {
    setEnvLine(FILES.web, 'DEMO_CONTACTS', JSON.stringify(contacts))
    console.log(`set DEMO_CONTACTS in ${FILES.web}`)
  }
}
