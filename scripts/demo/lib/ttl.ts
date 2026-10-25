import { Stellar } from '../../../apps/seller/demo-deps.ts'
import { rpc } from './chain.ts'
import { PASSPHRASE, STELLAR, USDC_SAC, assertMayTransact, explorerTx } from './env.ts'

/**
 * TTLs of the shared contracts every wallet depends on. Nobody owns their rent: if one archives, every delegated
 * payment (policy, verifier), every new wallet (account WASM) or the claim link (router) breaks until restored.
 */
type Shared = ReadonlyArray<{ readonly name: string; readonly contract?: string; readonly wasmHash?: string }>
const TESTNET_SHARED: Shared = [
  { name: 'spending-limit policy', contract: 'CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G' },
  { name: 'ed25519 verifier', contract: 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4' },
  { name: 'webauthn verifier', contract: 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F' },
  { name: 'account wasm', wasmHash: '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a' },
  { name: 'onboard router (S3)', contract: 'CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4' },
  { name: 'USDC SAC', contract: USDC_SAC },
]
/** Testnet ids are the ones S1–S5 proved; on pubnet the list is `SHARED_CONTRACTS=name=C…,name=C…` plus USDC. */
export const SHARED: Shared =
  STELLAR === 'testnet'
    ? TESTNET_SHARED
    : [
        ...(process.env['SHARED_CONTRACTS'] ?? '')
          .split(',')
          .filter(entry => entry.includes('='))
          .map(entry => ({ name: entry.slice(0, entry.indexOf('=')), contract: entry.slice(entry.indexOf('=') + 1) })),
        { name: 'USDC SAC', contract: USDC_SAC },
      ]

export const LEDGER_SECONDS = 5
const instanceKey = (contract: string) =>
  Stellar.xdr.LedgerKey.contractData(
    new Stellar.xdr.LedgerKeyContractData({
      contract: new Stellar.Address(contract).toScAddress(),
      key: Stellar.xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: Stellar.xdr.ContractDataDurability.persistent(),
    }),
  )
const codeKey = (hashHex: string) =>
  Stellar.xdr.LedgerKey.contractCode(new Stellar.xdr.LedgerKeyContractCode({ hash: Buffer.from(hashHex, 'hex') }))

export interface EntryTtl {
  readonly group: string
  readonly entry: 'instance' | 'wasm'
  readonly id: string
  readonly key: Stellar.xdr.LedgerKey
  /** undefined when the entry is not live (archived or missing) */
  readonly liveUntil: number | undefined
  readonly bytes: number | undefined
}

/** Reads every shared entry's `liveUntilLedgerSeq`; the WASM behind each instance is found from the instance. */
export async function readShared(): Promise<{ latest: number; entries: Array<EntryTtl> }> {
  const latest = (await rpc.getLatestLedger()).sequence
  const entries: Array<EntryTtl> = []
  for (const shared of SHARED) {
    let wasm = shared.wasmHash
    if (shared.contract !== undefined) {
      const key = instanceKey(shared.contract)
      const found = (await rpc.getLedgerEntries(key)).entries[0]
      entries.push({
        group: shared.name,
        entry: 'instance',
        id: shared.contract,
        key,
        liveUntil: found?.liveUntilLedgerSeq,
        bytes: found?.val.toXDR().length,
      })
      const executable = found?.val.contractData().val().instance().executable()
      if (executable?.switch().name === 'contractExecutableWasm') wasm = executable.wasmHash().toString('hex')
    }
    if (wasm !== undefined) {
      const key = codeKey(wasm)
      const found = (await rpc.getLedgerEntries(key)).entries[0]
      entries.push({
        group: shared.name,
        entry: 'wasm',
        id: wasm,
        key,
        liveUntil: found?.liveUntilLedgerSeq,
        bytes: found?.val.toXDR().length,
      })
    }
  }
  return { latest, entries }
}

/** Approximate wall-clock time of a future ledger (ledgers close every 5 s). */
export const ledgerTime = (latest: number, ledger: number) =>
  new Date(Date.now() + (ledger - latest) * LEDGER_SECONDS * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
export const daysLeft = (latest: number, ledger: number) => ((ledger - latest) * LEDGER_SECONDS) / 86_400

/** A transaction's fee field is a uint32 of stroops, so one Soroban tx can spend at most ~429 XLM on resources. */
export const MAX_TX_FEE_XLM = 420

const simulateFee = async (tx: Stellar.Transaction) => {
  const sim = await rpc.simulateTransaction(tx)
  if (!Stellar.rpc.Api.isSimulationSuccess(sim)) throw new Error(`simulation failed: ${sim.error}`)
  return Number(sim.minResourceFee) / 1e7
}

async function sendSoroban(source: Stellar.Keypair, tx: Stellar.Transaction, maxFeeXlm: number, label: string) {
  assertMayTransact(label)
  const sim = await rpc.simulateTransaction(tx)
  if (!Stellar.rpc.Api.isSimulationSuccess(sim)) throw new Error(`${label}: simulation failed: ${sim.error}`)
  const feeXlm = Number(sim.minResourceFee) / 1e7
  if (feeXlm > maxFeeXlm) throw new Error(`${label}: resource fee ${feeXlm} XLM exceeds the ${maxFeeXlm} XLM cap`)
  const prepared = Stellar.rpc.assembleTransaction(tx, sim).build()
  prepared.sign(source)
  const sent = await rpc.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new Error(`${label}: send failed`)
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const got = await rpc.getTransaction(sent.hash)
    if (got.status === Stellar.rpc.Api.GetTransactionStatus.NOT_FOUND) continue
    const charged = got.resultXdr?.feeCharged().toString() ?? '?'
    if (got.status !== Stellar.rpc.Api.GetTransactionStatus.SUCCESS)
      throw new Error(`${label}: ${got.status} ${explorerTx(sent.hash)}`)
    return { hash: sent.hash, ledger: got.ledger, feeChargedStroops: charged, explorer: explorerTx(sent.hash) }
  }
  throw new Error(`${label}: not final after 60 s (${sent.hash})`)
}

const footprintTx = async (
  source: Stellar.Keypair,
  data: Stellar.xdr.SorobanTransactionData,
  op: Stellar.xdr.Operation,
) =>
  new Stellar.TransactionBuilder(await rpc.getAccount(source.publicKey()), {
    fee: '1000',
    networkPassphrase: PASSPHRASE,
  })
    .setSorobanData(data)
    .addOperation(op)
    .setTimeout(120)
    .build()

const extendTx = async (source: Stellar.Keypair, keys: Array<Stellar.xdr.LedgerKey>, ledgers: number) =>
  footprintTx(
    source,
    new Stellar.SorobanDataBuilder().setReadOnly(keys).build(),
    Stellar.Operation.extendFootprintTtl({ extendTo: ledgers }),
  )

/**
 * ExtendFootprintTTL until every key lives at least `ledgers` past the current ledger. Anyone may pay for it. At
 * testnet's current rent a big entry costs more than one transaction can pay, so it goes in steps, each sized by
 * simulation to stay under `maxFeeXlm` (and the uint32 fee ceiling).
 */
export async function extend(
  source: Stellar.Keypair,
  keys: Array<Stellar.xdr.LedgerKey>,
  ledgers: number,
  maxFeeXlm: number,
  label: string,
) {
  const cap = Math.min(maxFeeXlm, MAX_TX_FEE_XLM)
  const steps: Array<Awaited<ReturnType<typeof sendSoroban>> & { readonly extendTo: number }> = []
  for (let round = 0; round < 12; round++) {
    const latest = (await rpc.getLatestLedger()).sequence
    const lives = (await rpc.getLedgerEntries(...keys)).entries.map(e => e.liveUntilLedgerSeq ?? latest)
    const shortest = Math.min(...lives) - latest
    if (shortest >= ledgers - 20) break
    let step = ledgers
    while ((await simulateFee(await extendTx(source, keys, step))) > cap) {
      step = shortest + Math.floor((step - shortest) / 2)
      if (step - shortest < 100) throw new Error(`${label}: cannot extend within ${cap} XLM per transaction`)
    }
    const sent = await sendSoroban(source, await extendTx(source, keys, step), cap, `${label} → +${step} ledgers`)
    console.log(`${label}: extendTo ${step} ledgers, ${Number(sent.feeChargedStroops) / 1e7} XLM, ${sent.explorer}`)
    steps.push({ ...sent, extendTo: step })
  }
  return steps
}

/** RestoreFootprint for archived entries (then extend them). */
export async function restore(
  source: Stellar.Keypair,
  keys: Array<Stellar.xdr.LedgerKey>,
  maxFeeXlm: number,
  label: string,
) {
  const data = new Stellar.SorobanDataBuilder().setReadWrite(keys).build()
  return sendSoroban(source, await footprintTx(source, data, Stellar.Operation.restoreFootprint({})), maxFeeXlm, label)
}
