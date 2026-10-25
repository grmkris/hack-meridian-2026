import { Schema } from 'effect'

import { Stellar } from '../../../apps/seller/demo-deps.ts'
import {
  HORIZON_URL,
  PASSPHRASE,
  RPC_URL,
  STELLAR,
  USDC_ISSUER,
  USDC_SAC,
  XLM_SAC,
  assertMayTransact,
  explorerTx,
} from './env.ts'

/** Classic (Horizon) and Soroban (RPC) helpers for the demo accounts. Testnet only. */
export const horizon = new Stellar.Horizon.Server(HORIZON_URL)
export const rpc = new Stellar.rpc.Server(RPC_URL)
export const USDC = new Stellar.Asset('USDC', USDC_ISSUER)

const native = (value: Stellar.xdr.ScVal): unknown => Stellar.scValToNative(value)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function exists(address: string): Promise<boolean> {
  const response = await fetch(`${HORIZON_URL}/accounts/${address}`)
  return response.ok
}

/** Friendbot funds a new account with 10,000 XLM; a no-op when the account exists. */
export async function friendbot(address: string): Promise<'funded' | 'exists'> {
  if (await exists(address)) return 'exists'
  if (STELLAR !== 'testnet') throw new Error(`friendbot exists only on testnet; fund ${address} by hand`)
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(`https://friendbot.stellar.org?addr=${address}`)
    if (response.ok || (await exists(address))) return 'funded'
    console.log(`friendbot ${address} → ${response.status} (attempt ${attempt})`)
    await sleep(3_000 * attempt)
  }
  throw new Error(`friendbot could not fund ${address}`)
}

/** Builds, signs (source + extra signers) and submits a classic transaction; returns its hash. */
export async function submit(
  source: Stellar.Keypair,
  operations: ReadonlyArray<Stellar.xdr.Operation>,
  label: string,
  signers: ReadonlyArray<Stellar.Keypair> = [],
): Promise<string> {
  assertMayTransact(label)
  const account = await horizon.loadAccount(source.publicKey())
  const builder = new Stellar.TransactionBuilder(account, { fee: '1000', networkPassphrase: PASSPHRASE }).setTimeout(
    120,
  )
  for (const operation of operations) builder.addOperation(operation)
  const tx = builder.build()
  tx.sign(source, ...signers)
  const result = await horizon.submitTransaction(tx)
  console.log(`${label}: ${explorerTx(result.hash)}`)
  return result.hash
}

const HorizonAccount = Schema.Struct({
  subentry_count: Schema.Finite,
  balances: Schema.Array(
    Schema.Struct({
      asset_type: Schema.String,
      asset_code: Schema.optional(Schema.String),
      asset_issuer: Schema.optional(Schema.String),
      balance: Schema.String,
    }),
  ),
})
const HorizonTransaction = Schema.Struct({
  ledger: Schema.Finite,
  successful: Schema.Boolean,
  source_account: Schema.String,
  fee_account: Schema.optional(Schema.String),
  fee_charged: Schema.Union([Schema.String, Schema.Finite]),
  created_at: Schema.String,
})

export async function classicBalances(address: string) {
  const response = await fetch(`${HORIZON_URL}/accounts/${address}`)
  if (!response.ok) return undefined
  const account = Schema.decodeUnknownSync(HorizonAccount)(await response.json())
  const xlm = account.balances.find(b => b.asset_type === 'native')?.balance ?? '0'
  const line = account.balances.find(b => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER)
  return { xlm, usdc: line?.balance ?? null, trustline: line !== undefined, subentries: account.subentry_count }
}

export async function ensureTrustline(account: Stellar.Keypair, label: string) {
  const balances = await classicBalances(account.publicKey())
  if (balances?.trustline === true) return undefined
  return submit(account, [Stellar.Operation.changeTrust({ asset: USDC })], `${label} USDC trustline`)
}

/** Buys exactly `amount` USDC on the testnet DEX with XLM (path payment to self), spending at most `maxXlm`. */
export const buyUsdc = (account: Stellar.Keypair, amount: string, maxXlm: string, label: string) =>
  submit(
    account,
    [
      Stellar.Operation.pathPaymentStrictReceive({
        sendAsset: Stellar.Asset.native(),
        sendMax: maxXlm,
        destination: account.publicKey(),
        destAsset: USDC,
        destAmount: amount,
        path: [],
      }),
    ],
    `${label} buys ${amount} USDC on the testnet DEX`,
  )

/** Read-only Soroban call by simulation; `source` must be an existing account (it pays nothing). */
export async function view(source: string, contract: string, fn: string, args: Array<Stellar.xdr.ScVal> = []) {
  const account = await rpc.getAccount(source)
  const tx = new Stellar.TransactionBuilder(account, { fee: '1000', networkPassphrase: PASSPHRASE })
    .addOperation(new Stellar.Contract(contract).call(fn, ...args))
    .setTimeout(60)
    .build()
  const sim = await rpc.simulateTransaction(tx)
  if (!Stellar.rpc.Api.isSimulationSuccess(sim) || sim.result === undefined)
    throw new Error(`${fn} on ${contract}: ${'error' in sim ? sim.error : 'no result'}`)
  const value: unknown = Stellar.scValToNative(sim.result.retval)
  return value
}

/** SAC balances (stroops) of any address, G or C, read through the asset contracts. */
export async function sacBalances(source: string, holder: string) {
  const arg = new Stellar.Address(holder).toScVal()
  const read = async (sac: string) => {
    try {
      const value = await view(source, sac, 'balance', [arg])
      return typeof value === 'bigint' ? value : BigInt(String(value))
    } catch {
      return 0n
    }
  }
  const [usdcStroops, xlmStroops] = await Promise.all([read(USDC_SAC), read(XLM_SAC)])
  return { usdc: usdcStroops, xlm: xlmStroops }
}

/** Invokes a contract with `source` as transaction source, fee payer and (source-account) authorizer. */
export async function invoke(source: Stellar.Keypair, operation: Stellar.xdr.Operation, label: string) {
  assertMayTransact(label)
  const account = await rpc.getAccount(source.publicKey())
  const raw = new Stellar.TransactionBuilder(account, { fee: '1000', networkPassphrase: PASSPHRASE })
    .addOperation(operation)
    .setTimeout(120)
    .build()
  const sim = await rpc.simulateTransaction(raw)
  if (!Stellar.rpc.Api.isSimulationSuccess(sim)) throw new Error(`${label}: simulation failed: ${sim.error}`)
  const tx = Stellar.rpc.assembleTransaction(raw, sim).build()
  tx.sign(source)
  const sent = await rpc.sendTransaction(tx)
  if (sent.status === 'ERROR') throw new Error(`${label}: send failed`)
  for (let i = 0; i < 60; i++) {
    await sleep(1_000)
    const got = await rpc.getTransaction(sent.hash)
    if (got.status === Stellar.rpc.Api.GetTransactionStatus.NOT_FOUND) continue
    if (got.status !== Stellar.rpc.Api.GetTransactionStatus.SUCCESS)
      throw new Error(`${label}: ${got.status} ${explorerTx(sent.hash)}`)
    console.log(`${label}: ${explorerTx(sent.hash)}`)
    return {
      hash: sent.hash,
      ledger: got.ledger,
      returnValue: got.returnValue === undefined ? undefined : native(got.returnValue),
    }
  }
  throw new Error(`${label}: not final after 60 s (${sent.hash})`)
}

/** USDC SAC transfer from a classic account to any address (G or C); the sender is source and fee payer. */
export const sacTransfer = (from: Stellar.Keypair, to: string, amountStroops: bigint, label: string) =>
  invoke(
    from,
    new Stellar.Contract(USDC_SAC).call(
      'transfer',
      new Stellar.Address(from.publicKey()).toScVal(),
      new Stellar.Address(to).toScVal(),
      Stellar.nativeToScVal(amountStroops, { type: 'i128' }),
    ),
    label,
  )

export interface TxFacts {
  readonly hash: string
  readonly ledger: number
  readonly successful: boolean
  readonly source: string
  readonly feeAccount: string
  readonly feeCharged: string
  readonly createdAt: string
  readonly explorer: string
}

/** What a transaction cost and who paid it, from Horizon (retries while it is indexed). */
export async function txFacts(hash: string, tries = 12): Promise<TxFacts | undefined> {
  for (let i = 0; i < tries; i++) {
    const response = await fetch(`${HORIZON_URL}/transactions/${hash}`)
    if (response.ok) {
      const t = Schema.decodeUnknownSync(HorizonTransaction)(await response.json())
      return {
        hash,
        ledger: t.ledger,
        successful: t.successful,
        source: t.source_account,
        feeAccount: t.fee_account ?? t.source_account,
        feeCharged: String(t.fee_charged),
        createdAt: t.created_at,
        explorer: explorerTx(hash),
      }
    }
    await sleep(1_000)
  }
  return undefined
}
