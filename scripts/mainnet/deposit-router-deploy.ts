import { Schema } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { PUBNET, TESTNET } from '../../packages/stellar/src/network.ts'
import {
  DRY_RUN,
  FILES,
  NET,
  ROOT,
  STROOPS,
  announce,
  contractCodeKey,
  contractExists,
  contractIdFor,
  contractInstanceKey,
  explorerAddress,
  flag,
  keypair,
  ledgerEntries,
  publicKey,
  saltOf,
  sorobanOp,
  type Spend,
} from './lib.ts'

/**
 * The deposit router v2 on pubnet (contracts/deposit, docs/spikes/s8-deposit.md): upload the WASM (7bc3752b…, the
 * testnet v2 build), deploy it from relayer A with the pubnet USDC SAC as its token, extend the code's and the
 * instance's TTL, record it in contracts/deployments/mainnet.json and print the DEPOSIT_ROUTER_ID line for
 * apps/web/.env.mainnet.
 *
 *   bun scripts/mainnet/deposit-router-deploy.ts --dry-run              simulate (upload; the rest once the code exists)
 *   HM26_MAINNET_GO=yes bun scripts/mainnet/deposit-router-deploy.ts    on the orchestrator's go
 *     --wasm <path>     default contracts/target/wasm32v1-none/release/deposit.wasm
 *                       (rebuild: `stellar contract build --package deposit` in contracts/)
 *     --ttl <ledgers>   extend code and instance to live this many ledgers from now (default 3,000,000 ≈ 173 days)
 *
 * Before anything is signed: the local WASM hashes to 7bc3752b…, its bytes equal the code uploaded on testnet (read
 * from testnet RPC), the token is the pubnet USDC SAC derived from the issuer, and each simulated fee is under its
 * ceiling. After: the code reads back as 7bc3752b…, the instance exists at the id precomputed from relayer A and a fixed
 * salt, and its `token()` view answers the USDC SAC. Idempotent: what already exists is skipped.
 */
const DEPOSIT_WASM_HASH = '7bc3752b337ff7b4c13683e5d1861d404ff069b01cf3c1ff4748055c48fb0c14'
const SALT = 'hm26/mainnet/deposit-router/v2'
const TESTNET_TWIN = 'CAFLFU5GH7QZ6KF3FBKRV7VW5XFYUKQPCFFTCPTKVEUG4TDT5B2ZOXGL'
const TOKEN = PUBNET.contracts.usdcSac
if (TOKEN !== 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75')
  throw new Error(`the pubnet USDC SAC derives to ${TOKEN}, not CCW67TSZ…MI75`)

const wasmPath = flag('--wasm') ?? join(ROOT, 'contracts/target/wasm32v1-none/release/deposit.wasm')
const ttl = Number(flag('--ttl') ?? '3000000')
const wasm = readFileSync(wasmPath)
const sha = new Bun.CryptoHasher('sha256').update(wasm).digest('hex')
if (sha !== DEPOSIT_WASM_HASH) throw new Error(`${wasmPath} hashes to ${sha}, not ${DEPOSIT_WASM_HASH}; rebuild`)
console.log(`local WASM ${wasmPath}: ${wasm.length} B, sha256 ${sha} (expected)`)

const testnetCode = await new Stellar.rpc.Server(TESTNET.rpcUrl).getLedgerEntries(contractCodeKey(DEPOSIT_WASM_HASH))
const twin = testnetCode.entries[0]?.val.contractCode().code()
if (twin === undefined || !Buffer.from(twin).equals(wasm))
  throw new Error('the local WASM is not byte-identical to the deposit router code uploaded on testnet')
console.log(`testnet code ${DEPOSIT_WASM_HASH.slice(0, 8)}… (router ${TESTNET_TWIN}): byte-identical`)

const deployer = publicKey('relayerA')
const id = contractIdFor(deployer, saltOf(SALT))
const codeKey = contractCodeKey(DEPOSIT_WASM_HASH)
const instanceKey = contractInstanceKey(id)
const uploaded = (await ledgerEntries([codeKey])).find(codeKey) !== undefined
const deployed = await contractExists(id)
console.log(
  `mainnet: code ${uploaded ? 'already uploaded' : 'not uploaded'}; router ${id} ${deployed ? 'exists' : 'not deployed'}`,
)

const spends: Array<Spend> = [
  ...(uploaded ? [] : [{ what: 'upload deposit WASM (5.4 KB)', payer: 'relayer A', xlm: 8.2 }]),
  ...(deployed ? [] : [{ what: 'deploy the router instance with its token', payer: 'relayer A', xlm: 0.1 }]),
  { what: `extend code and instance TTL to ${ttl} ledgers`, payer: 'relayer A', xlm: 3.7 },
]
const mode = announce('Deposit router v2 deploy', spends)
const signer = mode === 'submit' ? keypair('relayerA') : undefined

let uploadTx: string | null = null
if (!uploaded) {
  const upload = await sorobanOp({
    label: 'upload deposit WASM',
    source: deployer,
    op: Stellar.Operation.uploadContractWasm({ wasm }),
    // 8.13 XLM simulated on 25 Oct 21:15 UTC (the code entry's first rent on pubnet), not the 2.49 of the onboard upload.
    ceilingStroops: 10n * STROOPS,
    signer,
  })
  const returned = upload.returnValue?.bytes()
  if (returned === undefined || Buffer.from(returned).toString('hex') !== DEPOSIT_WASM_HASH)
    throw new Error('the upload did not return the expected WASM hash')
  uploadTx = upload.sent?.hash ?? null
}

let deployTx: string | null = null
if (!deployed) {
  if (!uploaded && mode !== 'submit') console.log('  deploy the router: needs the code on mainnet first; not simulated')
  else {
    const deploy = await sorobanOp({
      label: 'deploy the deposit router',
      source: deployer,
      op: Stellar.Operation.createCustomContract({
        address: new Stellar.Address(deployer),
        wasmHash: Buffer.from(DEPOSIT_WASM_HASH, 'hex'),
        salt: saltOf(SALT),
        constructorArgs: [new Stellar.Address(TOKEN).toScVal()],
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

if (DRY_RUN && !(uploaded && deployed)) {
  console.log(`\ndry run done; the router id will be ${id}`)
  process.exit(0)
}

const extend = await sorobanOp({
  label: `extend code + instance TTL to ${ttl} ledgers`,
  source: deployer,
  data: new Stellar.SorobanDataBuilder().setReadOnly([codeKey, instanceKey]).build(),
  op: Stellar.Operation.extendFootprintTtl({ extendTo: ttl }),
  // 3.65 XLM simulated on 25 Oct 21:30 UTC for both entries to 3,000,000 ledgers.
  ceilingStroops: 4n * STROOPS,
  signer,
})
const extendTx = extend.sent?.hash ?? null
if (DRY_RUN) {
  console.log(`\ndry run done; the router ${id} exists`)
  process.exit(0)
}

const read = await ledgerEntries([codeKey, instanceKey])
const back = read.find(codeKey)?.val.contractCode().code()
const backSha = back === undefined ? 'missing' : new Bun.CryptoHasher('sha256').update(back).digest('hex')
if (backSha !== DEPOSIT_WASM_HASH) throw new Error(`mainnet code reads back as ${backSha}`)
const instance = read.find(instanceKey)
if (instance === undefined) throw new Error(`router ${id} not found after the deploy`)
const liveUntil = {
  code: read.find(codeKey)?.liveUntilLedgerSeq ?? null,
  instance: instance.liveUntilLedgerSeq ?? null,
}
const tokenView = await sorobanOp({
  label: 'read token()',
  source: deployer,
  op: Stellar.Operation.invokeContractFunction({ contract: id, function: 'token', args: [] }),
  ceilingStroops: STROOPS,
  signer: undefined,
})
const token = tokenView.returnValue === undefined ? 'none' : Stellar.Address.fromScVal(tokenView.returnValue).toString()
if (token !== TOKEN) throw new Error(`token() answers ${token}, not ${TOKEN}`)
console.log(`router verified: code ${DEPOSIT_WASM_HASH.slice(0, 8)}…, token() = USDC SAC, live until`, liveUntil)

const Recorded = Schema.Struct({ contracts: Schema.Record(Schema.String, Schema.Unknown) })
const others = existsSync(FILES.deployments)
  ? Schema.decodeUnknownSync(Recorded)(JSON.parse(readFileSync(FILES.deployments, 'utf8'))).contracts
  : {}
const previous: Record<string, unknown> =
  typeof others['deposit'] === 'object' && others['deposit'] !== null ? { ...others['deposit'] } : {}
const kept = (key: string, now: string | null) => now ?? (typeof previous[key] === 'string' ? previous[key] : null)
const record = {
  network: 'pubnet',
  rpcUrl: NET.rpcUrl,
  networkPassphrase: NET.passphrase,
  contracts: {
    ...others,
    deposit: {
      id,
      wasmHash: DEPOSIT_WASM_HASH,
      deployer,
      salt: SALT,
      deployedAt: deployTx === null ? kept('deployedAt', null) : new Date().toISOString(),
      uploadTx: kept('uploadTx', uploadTx),
      deployTx: kept('deployTx', deployTx),
      extendTx: kept('extendTx', extendTx),
      liveUntilLedger: liveUntil,
      constructor: { token: TOKEN },
      source: 'contracts/deposit',
      testnetTwin: TESTNET_TWIN,
      evidence: 'docs/spikes/s8-deposit.md',
      explorer: explorerAddress(id),
    },
  },
}
writeFileSync(FILES.deployments, `${JSON.stringify(record, null, 2)}\n`)
console.log(`\nrecorded in ${FILES.deployments}; ${explorerAddress(id)}`)
console.log(`DEPOSIT_ROUTER_ID=${id}`)
