import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { PUBNET } from '../../packages/stellar/src/network.ts'

/**
 * Shared pieces of the mainnet scripts (docs/MAINNET.md, Track M). Pubnet only; ids come from @hm/stellar's `PUBNET`
 * preset. Secrets are read from the gitignored env files (mode 600) and never printed; public keys, ids and hashes are.
 * Nothing signs or submits unless `HM26_MAINNET_GO=yes` (Kristjan's explicit go for that step); `--dry-run` simulates
 * against pubnet RPC instead and never signs.
 */
export const ROOT = resolve(import.meta.dir, '../..')
export const FILES = {
  /** The mainnet stage's settings and Worker secrets (apps/web/alchemy.run.ts reads `.env.<stage>`). */
  web: join(ROOT, 'apps/web/.env.mainnet'),
  /** The mainnet demo accounts' secrets (scripts/demo/lib/env.ts reads it with `--network pubnet`). */
  demo: join(ROOT, 'scripts/demo/.env.pubnet'),
  /** The mainnet seller's Worker secrets (OZ_FACILITATOR_KEY). */
  sellerVars: join(ROOT, 'apps/seller/.dev.vars.mainnet'),
  /** Public: the mainnet demo contacts and accounts. */
  seeds: join(ROOT, 'scripts/demo/seeds.pubnet.json'),
  /** Public: contracts we deployed on mainnet. */
  deployments: join(ROOT, 'contracts/deployments/mainnet.json'),
} as const

export const NET = PUBNET
export const USDC = new Stellar.Asset('USDC', PUBNET.usdcIssuer)
/** The CAP-73 router's WASM (contracts/onboard), byte-identical to the testnet upload `c40acea7…`. */
export const ROUTER_WASM_HASH = '39c97734a92ac1057da3d4785cbc2307d937a3275fc6bcbb76bf6aa5bd503888'
/** Inclusion fee bid for every transaction (mainnet p10–p99 was 200 stroops; docs/research/mainnet.md). */
export const INCLUSION_FEE = 10_000
export const STROOPS = 10_000_000n

export const args = process.argv.slice(2)
export const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
export const DRY_RUN = args.includes('--dry-run')
const networkArg = flag('--network')
if (networkArg !== undefined && networkArg !== 'pubnet') {
  console.error(`scripts/mainnet run on pubnet only (got --network ${networkArg})`)
  process.exit(2)
}

export const xlm = (stroops: bigint): string => {
  const sign = stroops < 0n ? '-' : ''
  const abs = stroops < 0n ? -stroops : stroops
  return `${sign}${abs / STROOPS}.${(abs % STROOPS).toString().padStart(7, '0')}`
}
export const toStroops = (decimal: string): bigint => {
  const [whole = '0', fraction = ''] = decimal.split('.')
  return BigInt(whole) * STROOPS + BigInt(fraction.padEnd(7, '0').slice(0, 7))
}
export const explorerTx = (hash: string) => `${PUBNET.explorerBase}/tx/${hash}`
export const explorerAddress = (address: string) =>
  `${PUBNET.explorerBase}/${address.startsWith('C') ? 'contract' : 'account'}/${address}`

// ---------------------------------------------------------------------------------------------------- env files

/** `NAME=value` lines, parsed exactly as apps/web/alchemy.run.ts `readEnvFile` does (no quotes, `#` comments). */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#') && line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')).replace(/^export\s+/u, ''), line.slice(line.indexOf('=') + 1)]),
  )
}

/** Throws unless the file exists and is readable by its owner only. */
export function assertPrivate(file: string) {
  if (!existsSync(file)) throw new Error(`${file} is missing (bun scripts/mainnet/keys.ts creates it)`)
  const mode = statSync(file).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${file} is mode ${mode.toString(8)}; chmod 600 it`)
}

/** Sets `name=value` in an env file in place (replacing the line, or appending), keeping mode 600. Prints nothing. */
export function setEnvLine(file: string, name: string, value: string) {
  assertPrivate(file)
  const lines = readFileSync(file, 'utf8').split('\n')
  const index = lines.findIndex(line =>
    line
      .trim()
      .replace(/^export\s+/u, '')
      .startsWith(`${name}=`),
  )
  if (index >= 0) lines[index] = `${name}=${value}`
  else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${name}=${value}`)
  writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  chmodSync(file, 0o600)
}

// ---------------------------------------------------------------------------------------------------- accounts

/** Each role's secret name in scripts/demo/.env.pubnet. Alice has no key: relayer A owns her smart account. */
export const ROLES = {
  relayerA: 'RELAYER_SECRET',
  relayerB: 'RELAYER_B_SECRET',
  treasury: 'TREASURY_SECRET',
  seller: 'SELLER_SECRET',
  bob: 'BOB_SECRET',
  carol: 'CAROL_SECRET',
} as const
export type Role = keyof typeof ROLES
export const ROLE_LIST: ReadonlyArray<Role> = ['relayerA', 'relayerB', 'treasury', 'seller', 'bob', 'carol']

export function keypair(role: Role): Stellar.Keypair {
  assertPrivate(FILES.demo)
  const secret = readEnvFile(FILES.demo)[ROLES[role]]
  if (secret === undefined || secret === '') throw new Error(`${ROLES[role]} is missing from ${FILES.demo}`)
  return Stellar.Keypair.fromSecret(secret)
}
export const publicKey = (role: Role): string => keypair(role).publicKey()

/** What each account must hold before its step (docs/mainnet-funding.md). */
export const FUNDING: Readonly<Record<Role, { readonly xlm: number; readonly usdc: number; readonly why: string }>> = {
  relayerA: { xlm: 25, usdc: 0, why: 'fee payer; router upload + deploy, Alice deploy, pocket reserves' },
  relayerB: { xlm: 10, usdc: 0, why: 'second fee payer (parallel sequence numbers)' },
  treasury: { xlm: 3, usdc: 30, why: 'USDC trustline; tops up the owner wallet; pays the seller smoke test' },
  seller: { xlm: 2, usdc: 0, why: 'x402 payTo; USDC trustline' },
  bob: { xlm: 2, usdc: 0, why: 'contact Bob: USDC trustline (usdc_ready)' },
  carol: { xlm: 2, usdc: 0, why: 'contact Carol: no trustline (claim link needs ≥ 1.5 XLM)' },
}

// ---------------------------------------------------------------------------------------------------- RPC

const servers = [PUBNET.rpcUrl, PUBNET.rpcFallbackUrl]
  .filter((url): url is string => url !== null && url !== '')
  .map(url => ({ url, server: new Stellar.rpc.Server(url) }))

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A read on the primary RPC, then on the fallback when the primary does not answer. */
export async function rpcRead<A>(label: string, f: (server: Stellar.rpc.Server) => Promise<A>): Promise<A> {
  let last: unknown
  for (const { url, server } of servers) {
    try {
      return await f(server)
    } catch (error) {
      last = error
      console.log(`  ${label} on ${url}: ${messageOf(error).split('\n')[0]}`)
    }
  }
  throw new Error(`${label}: no RPC answered (${messageOf(last)})`)
}

const accountKey = (address: string) =>
  Stellar.xdr.LedgerKey.account(
    new Stellar.xdr.LedgerKeyAccount({ accountId: Stellar.Keypair.fromPublicKey(address).xdrAccountId() }),
  )
const trustlineKey = (address: string) =>
  Stellar.xdr.LedgerKey.trustline(
    new Stellar.xdr.LedgerKeyTrustLine({
      accountId: Stellar.Keypair.fromPublicKey(address).xdrAccountId(),
      asset: USDC.toTrustLineXDRObject(),
    }),
  )
export const contractInstanceKey = (id: string) =>
  Stellar.xdr.LedgerKey.contractData(
    new Stellar.xdr.LedgerKeyContractData({
      contract: Stellar.Address.fromString(id).toScAddress(),
      key: Stellar.xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: Stellar.xdr.ContractDataDurability.persistent(),
    }),
  )
export const contractCodeKey = (hashHex: string) =>
  Stellar.xdr.LedgerKey.contractCode(new Stellar.xdr.LedgerKeyContractCode({ hash: Buffer.from(hashHex, 'hex') }))

export async function ledgerEntries(keys: ReadonlyArray<Stellar.xdr.LedgerKey>) {
  const response = await rpcRead('getLedgerEntries', s => s.getLedgerEntries(...keys))
  const find = (key: Stellar.xdr.LedgerKey) => {
    const wanted = key.toXDR('base64')
    return response.entries.find(entry => entry.key.toXDR('base64') === wanted)
  }
  return { latestLedger: response.latestLedger, find }
}

export interface AccountState {
  readonly address: string
  readonly exists: boolean
  readonly xlm: bigint
  /** null = no USDC trustline. */
  readonly usdc: bigint | null
  readonly subentries: number
  /** XLM locked by the base reserve: (2 + subentries) × 0.5. */
  readonly reserve: bigint
}

export async function accountState(address: string): Promise<AccountState> {
  const read = await ledgerEntries([accountKey(address), trustlineKey(address)])
  const account = read.find(accountKey(address))
  const line = read.find(trustlineKey(address))
  if (account === undefined) return { address, exists: false, xlm: 0n, usdc: null, subentries: 0, reserve: 0n }
  const entry = account.val.account()
  const subentries = entry.numSubEntries()
  return {
    address,
    exists: true,
    xlm: BigInt(entry.balance().toString()),
    usdc: line === undefined ? null : BigInt(line.val.trustLine().balance().toString()),
    subentries,
    reserve: BigInt(2 + subentries) * 5_000_000n,
  }
}

export async function contractExists(id: string): Promise<boolean> {
  const read = await ledgerEntries([contractInstanceKey(id)])
  return read.find(contractInstanceKey(id)) !== undefined
}

/** The contract id `deployer` gets for `salt` on pubnet (what `createCustomContract` will return). */
export function contractIdFor(deployer: string, salt: Buffer): string {
  const preimage = Stellar.xdr.HashIdPreimage.envelopeTypeContractId(
    new Stellar.xdr.HashIdPreimageContractId({
      networkId: Stellar.hash(Buffer.from(PUBNET.passphrase)),
      contractIdPreimage: Stellar.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new Stellar.xdr.ContractIdPreimageFromAddress({
          address: Stellar.Address.fromString(deployer).toScAddress(),
          salt,
        }),
      ),
    }),
  )
  return Stellar.StrKey.encodeContract(Stellar.hash(preimage.toXDR()))
}
/** Deterministic salts make every deploy idempotent: the id is known before the deploy and checked first. */
export const saltOf = (label: string): Buffer => Stellar.hash(Buffer.from(label))
export const SALTS = { router: 'hm26/mainnet/onboard-router/v1', alice: 'hm26/mainnet/alice/v1' } as const
/** Both are deployed by relayer A, so their ids follow from its public key alone. */
export const routerId = () => contractIdFor(publicKey('relayerA'), saltOf(SALTS.router))
export const aliceId = () => contractIdFor(publicKey('relayerA'), saltOf(SALTS.alice))

// ---------------------------------------------------------------------------------------------------- spend + go

export interface Spend {
  readonly what: string
  readonly payer: string
  /** XLM spent or locked (reserve). */
  readonly xlm: number
  readonly usdc?: number
}

/**
 * Prints what the run will spend, then decides: `--dry-run` → simulate only; no `HM26_MAINNET_GO=yes` → refuse
 * (exit 2) before anything is signed; otherwise submit.
 */
export function announce(title: string, spends: ReadonlyArray<Spend>): 'dry-run' | 'submit' {
  console.log(`\n${title} (pubnet${DRY_RUN ? ', DRY RUN: simulate only, nothing is signed or sent' : ''})`)
  if (spends.length === 0) console.log('  nothing to do')
  for (const s of spends)
    console.log(
      `  - ${s.what}: ${s.xlm.toFixed(4)} XLM${s.usdc === undefined ? '' : ` + ${s.usdc.toFixed(2)} USDC`} from ${s.payer}`,
    )
  const totalXlm = spends.reduce((sum, s) => sum + s.xlm, 0)
  const totalUsdc = spends.reduce((sum, s) => sum + (s.usdc ?? 0), 0)
  console.log(`  total ≤ ${totalXlm.toFixed(4)} XLM${totalUsdc > 0 ? ` + ${totalUsdc.toFixed(2)} USDC` : ''}\n`)
  if (DRY_RUN) return 'dry-run'
  if (process.env['HM26_MAINNET_GO'] !== 'yes') {
    console.error("refusing: real funds on mainnet. Run with --dry-run, or HM26_MAINNET_GO=yes on Kristjan's go.")
    process.exit(2)
  }
  return 'submit'
}

// ---------------------------------------------------------------------------------------------------- transactions

export interface Sent {
  readonly hash: string
  readonly ledger: number
  readonly feeCharged: bigint
  readonly returnValue: Stellar.xdr.ScVal | undefined
}

async function sendAndPoll(tx: Stellar.Transaction, label: string): Promise<Sent> {
  const hash = tx.hash().toString('hex')
  for (const { url, server } of servers) {
    let sent: Stellar.rpc.Api.SendTransactionResponse
    try {
      sent = await server.sendTransaction(tx)
      for (let retry = 0; sent.status === 'TRY_AGAIN_LATER' && retry < 3; retry++) {
        await sleep(3_000)
        sent = await server.sendTransaction(tx)
      }
    } catch (error) {
      console.log(`  ${label}: sendTransaction on ${url} failed (${messageOf(error)}); trying the next RPC`)
      continue
    }
    if (sent.status === 'ERROR')
      throw new Error(`${label}: rejected before apply: ${sent.errorResult?.result().switch().name ?? 'ERROR'}`)
    if (sent.status === 'TRY_AGAIN_LATER') throw new Error(`${label}: ${url} kept answering TRY_AGAIN_LATER`)
    // Poll the provider that took it (docs/research/mainnet.md risk 5).
    for (let i = 0; i < 90; i++) {
      await sleep(1_000)
      const got = await server.getTransaction(hash).catch(() => undefined)
      if (got === undefined || got.status === Stellar.rpc.Api.GetTransactionStatus.NOT_FOUND) continue
      if (got.status !== Stellar.rpc.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`${label}: ${got.status} ${explorerTx(hash)}`)
      console.log(`  ${label}: ${explorerTx(hash)}`)
      return {
        hash,
        ledger: got.ledger,
        feeCharged: BigInt(got.resultXdr.feeCharged().toString()),
        returnValue: got.returnValue,
      }
    }
    throw new Error(`${label}: not final after 90 s; check ${explorerTx(hash)} before retrying`)
  }
  throw new Error(`${label}: no RPC accepted the transaction (hash ${hash}); check ${explorerTx(hash)}`)
}

const sourceAccount = async (address: string) => {
  const state = await ledgerEntries([accountKey(address)])
  const entry = state.find(accountKey(address))
  return {
    exists: entry !== undefined,
    account: new Stellar.Account(address, entry?.val.account().seqNum().toString() ?? '0'),
  }
}

export interface Simulated {
  readonly fee: bigint
  readonly resourceFee: bigint
  readonly returnValue: Stellar.xdr.ScVal | undefined
  readonly sent: Sent | undefined
}

/**
 * One Soroban operation with `source` as transaction source, fee payer and (source-account) authorizer: simulate →
 * assemble → refuse above `ceiling` → (submit only) sign, send, poll. A dry run simulates even when the source is not
 * funded yet (sequence 0); the simulated fee is what the run would declare.
 */
export async function sorobanOp(input: {
  readonly label: string
  readonly source: string
  readonly op: Stellar.xdr.Operation
  readonly ceilingStroops: bigint
  readonly signer: Stellar.Keypair | undefined
}): Promise<Simulated> {
  const { exists, account } = await sourceAccount(input.source)
  if (input.signer !== undefined && !exists) throw new Error(`${input.label}: ${input.source} is not funded`)
  const raw = new Stellar.TransactionBuilder(account, {
    fee: String(INCLUSION_FEE),
    networkPassphrase: PUBNET.passphrase,
  })
    .addOperation(input.op)
    .setTimeout(120)
    .build()
  const sim = await rpcRead(`simulate ${input.label}`, s => s.simulateTransaction(raw))
  if (!Stellar.rpc.Api.isSimulationSuccess(sim))
    throw new Error(`${input.label}: simulation failed: ${'error' in sim ? sim.error : 'unknown'}`)
  const tx = Stellar.rpc.assembleTransaction(raw, sim).build()
  const fee = BigInt(tx.fee)
  const resourceFee = BigInt(sim.minResourceFee)
  console.log(
    `  ${input.label}: simulated fee ${xlm(fee)} XLM (resource ${xlm(resourceFee)}), ceiling ${xlm(input.ceilingStroops)}${exists ? '' : ' [source not funded yet]'}`,
  )
  if (fee > input.ceilingStroops)
    throw new Error(`${input.label}: fee ${xlm(fee)} XLM is above the ceiling ${xlm(input.ceilingStroops)}; not sent`)
  if (input.signer === undefined) return { fee, resourceFee, returnValue: sim.result?.retval, sent: undefined }
  if (input.signer.publicKey() !== input.source) throw new Error(`${input.label}: signer is not the source`)
  tx.sign(input.signer)
  const sent = await sendAndPoll(tx, input.label)
  return { fee, resourceFee, returnValue: sent.returnValue ?? sim.result?.retval, sent }
}

/** A classic transaction from `source` (its own fee). Classic operations cannot be simulated: a dry run only prints. */
export async function classicOps(input: {
  readonly label: string
  readonly source: Stellar.Keypair
  readonly ops: ReadonlyArray<Stellar.xdr.Operation>
  readonly submit: boolean
}): Promise<Sent | undefined> {
  const { exists, account } = await sourceAccount(input.source.publicKey())
  const fee = BigInt(INCLUSION_FEE * input.ops.length)
  if (!input.submit) {
    console.log(`  ${input.label}: classic, fee ${xlm(fee)} XLM${exists ? '' : ' [source not funded yet]'} (not sent)`)
    return undefined
  }
  if (!exists) throw new Error(`${input.label}: ${input.source.publicKey()} is not funded`)
  const builder = new Stellar.TransactionBuilder(account, {
    fee: String(INCLUSION_FEE),
    networkPassphrase: PUBNET.passphrase,
  }).setTimeout(120)
  for (const op of input.ops) builder.addOperation(op)
  const tx = builder.build()
  tx.sign(input.source)
  return sendAndPoll(tx, input.label)
}
