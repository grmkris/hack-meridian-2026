import { Schema } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { TESTNET } from '../../packages/stellar/src/network.ts'
import {
  DRY_RUN,
  FILES,
  NET,
  ROOT,
  ROUTER_WASM_HASH,
  SALTS,
  STROOPS,
  announce,
  args,
  contractCodeKey,
  contractExists,
  explorerAddress,
  flag,
  keypair,
  ledgerEntries,
  publicKey,
  routerId,
  saltOf,
  setEnvLine,
  sorobanOp,
  type Spend,
} from './lib.ts'

/**
 * M3: upload contracts/onboard's WASM (39c97734…) and deploy the CAP-73 router on pubnet from relayer A; record it in
 * contracts/deployments/mainnet.json and print the ONBOARD_ROUTER_ID line for apps/web/.env.mainnet.
 *
 *   bun scripts/mainnet/router-deploy.ts --dry-run                 simulate (upload; the deploy once the code exists)
 *   HM26_MAINNET_GO=yes bun scripts/mainnet/router-deploy.ts       on Kristjan's "go M3"
 *     --write-env    also set ONBOARD_ROUTER_ID in apps/web/.env.mainnet
 *     --wasm <path>  default contracts/target/wasm32v1-none/release/onboard.wasm
 *                    (rebuild: `stellar contract build --package onboard` in contracts/)
 *
 * Before anything is signed: the local WASM hashes to 39c97734…, its bytes equal the code uploaded on testnet (read
 * from testnet RPC), and each simulated fee is under its ceiling (upload 4 XLM, deploy 0.5 XLM). After: the code read
 * back from mainnet hashes to 39c97734… and the instance exists at the id precomputed from relayer A and a fixed salt.
 * Idempotent: code already uploaded or an instance already deployed is skipped.
 */
const wasmPath = flag('--wasm') ?? join(ROOT, 'contracts/target/wasm32v1-none/release/onboard.wasm')
const wasm = readFileSync(wasmPath)
const sha = new Bun.CryptoHasher('sha256').update(wasm).digest('hex')
if (sha !== ROUTER_WASM_HASH) throw new Error(`${wasmPath} hashes to ${sha}, not ${ROUTER_WASM_HASH}; rebuild`)
console.log(`local WASM ${wasmPath}: ${wasm.length} B, sha256 ${sha} (expected)`)

const testnetCode = await new Stellar.rpc.Server(TESTNET.rpcUrl).getLedgerEntries(contractCodeKey(ROUTER_WASM_HASH))
const twin = testnetCode.entries[0]?.val.contractCode().code()
if (twin === undefined || !Buffer.from(twin).equals(wasm))
  throw new Error('the local WASM is not byte-identical to the router code uploaded on testnet')
console.log(`testnet code ${ROUTER_WASM_HASH.slice(0, 8)}… (router ${TESTNET.contracts.onboardRouter}): byte-identical`)

const deployer = publicKey('relayerA')
const id = routerId()
const codeKey = contractCodeKey(ROUTER_WASM_HASH)
const uploaded = (await ledgerEntries([codeKey])).find(codeKey) !== undefined
const deployed = await contractExists(id)
console.log(
  `mainnet: code ${uploaded ? 'already uploaded' : 'not uploaded'}; router ${id} ${deployed ? 'exists' : 'not deployed'}`,
)

const spends: Array<Spend> = [
  ...(uploaded ? [] : [{ what: 'upload onboard WASM (simulated 2.49 XLM on 25 Oct)', payer: 'relayer A', xlm: 2.6 }]),
  ...(deployed ? [] : [{ what: 'deploy the router instance (≈ 0.016 XLM re-priced)', payer: 'relayer A', xlm: 0.05 }]),
]
const mode = announce('M3 router deploy', spends)
const signer = mode === 'submit' ? keypair('relayerA') : undefined

let uploadTx: string | null = null
if (!uploaded) {
  const upload = await sorobanOp({
    label: 'upload onboard WASM',
    source: deployer,
    op: Stellar.Operation.uploadContractWasm({ wasm }),
    ceilingStroops: 4n * STROOPS,
    signer,
  })
  const returned = upload.returnValue?.bytes()
  if (returned === undefined || Buffer.from(returned).toString('hex') !== ROUTER_WASM_HASH)
    throw new Error('the upload did not return the expected WASM hash')
  uploadTx = upload.sent?.hash ?? null
}

let deployTx: string | null = null
if (!deployed) {
  const codeThere = uploaded || mode === 'submit'
  if (!codeThere) console.log('  deploy the router: needs the code on mainnet first; not simulated in a dry run')
  else {
    const deploy = await sorobanOp({
      label: 'deploy the router',
      source: deployer,
      op: Stellar.Operation.createCustomContract({
        address: new Stellar.Address(deployer),
        wasmHash: Buffer.from(ROUTER_WASM_HASH, 'hex'),
        salt: saltOf(SALTS.router),
      }),
      ceilingStroops: STROOPS / 2n,
      signer,
    })
    const returned =
      deploy.returnValue === undefined ? undefined : Stellar.Address.fromScVal(deploy.returnValue).toString()
    if (returned !== id) throw new Error(`the deploy returns ${returned ?? 'nothing'}, not the precomputed ${id}`)
    deployTx = deploy.sent?.hash ?? null
  }
}

if (DRY_RUN) {
  console.log(`\ndry run done; the router id will be ${id}`)
  process.exit(0)
}

const back = (await ledgerEntries([codeKey])).find(codeKey)?.val.contractCode().code()
const backSha = back === undefined ? 'missing' : new Bun.CryptoHasher('sha256').update(back).digest('hex')
if (backSha !== ROUTER_WASM_HASH) throw new Error(`mainnet code reads back as ${backSha}`)
if (!(await contractExists(id))) throw new Error(`router ${id} not found after the deploy`)

const Recorded = Schema.Struct({ contracts: Schema.Record(Schema.String, Schema.Unknown) })
const others = existsSync(FILES.deployments)
  ? Schema.decodeUnknownSync(Recorded)(JSON.parse(readFileSync(FILES.deployments, 'utf8'))).contracts
  : {}
const record = {
  network: 'pubnet',
  rpcUrl: NET.rpcUrl,
  networkPassphrase: NET.passphrase,
  contracts: {
    ...others,
    onboard: {
      id,
      wasmHash: ROUTER_WASM_HASH,
      deployer,
      salt: SALTS.router,
      deployedAt: new Date().toISOString(),
      uploadTx,
      deployTx,
      source: 'contracts/onboard',
      testnetTwin: TESTNET.contracts.onboardRouter,
      explorer: explorerAddress(id),
    },
  },
}
writeFileSync(FILES.deployments, `${JSON.stringify(record, null, 2)}\n`)
console.log(
  `\nrecorded in ${FILES.deployments}; router verified: code ${ROUTER_WASM_HASH.slice(0, 8)}…, ${explorerAddress(id)}`,
)
console.log(`ONBOARD_ROUTER_ID=${id}`)
if (args.includes('--write-env')) {
  setEnvLine(FILES.web, 'ONBOARD_ROUTER_ID', id)
  console.log(`set ONBOARD_ROUTER_ID in ${FILES.web}`)
}
