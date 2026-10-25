/**
 * Explain a Soroban tx's rent: the live testnet rent rate (formula copied from spikes/s1/src/tools/fee-ab.ts, i.e.
 * soroban-env-host compute_rent_write_fee_per_1kb, protocol ≥ 23) and, per tx, every contract-data entry whose size
 * or TTL changed. bun src/tools/rent.ts [hash…]
 */
import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

import { j } from '../env'
import { server } from '../signer'

async function config() {
  const get = async (id: string) => {
    const key = xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({ configSettingId: (xdr.ConfigSettingId as unknown as Record<string, () => xdr.ConfigSettingId>)[id]!() }),
    )
    // SAFETY: config-setting entries are a tagged union; the caller knows which arm each id returns.
    return (await server.getLedgerEntries(key)).entries[0]!.val.configSetting().value() as never as Record<string, () => { toString(): string }> & unknown[]
  }
  const cost = await get('configSettingContractLedgerCostV0')
  const arch = await get('configSettingStateArchival')
  const window = (await get('configSettingLiveSorobanStateSizeWindow')) as unknown as { toString(): string }[]
  const size = window.map(x => BigInt(x.toString())).reduce((a, b) => a + b, 0n) / BigInt(window.length)
  const low = BigInt(cost.rentFee1KbSorobanStateSizeLow!().toString())
  const high = BigInt(cost.rentFee1KbSorobanStateSizeHigh!().toString())
  const target = BigInt(cost.sorobanStateTargetSizeBytes!().toString())
  const growth = BigInt(cost.sorobanStateRentFeeGrowthFactor!().toString())
  const mult = high - low
  let fee1kb = (mult * size + target - 1n) / target + low
  if (size > target) fee1kb += (mult * growth * (size - target) + target - 1n) / target
  if (fee1kb < 1000n) fee1kb = 1000n
  return { size, target, overPct: (Number(size) / Number(target) - 1) * 100, fee1kb, atTarget: mult + low, denom: BigInt(arch.persistentRentRateDenominator!().toString()) }
}

const cfg = await config()
const rent = (bytes: bigint, ledgers: bigint, fee1kb = cfg.fee1kb) => (bytes * fee1kb * ledgers) / (1024n * cfg.denom)
console.log(
  j({
    liveStateBytes: cfg.size,
    targetBytes: cfg.target,
    overTargetPct: cfg.overPct.toFixed(3),
    rentFeePer1KbNow: cfg.fee1kb,
    rentFeePer1KbAtTarget: cfg.atTarget,
    multiplier: (Number(cfg.fee1kb) / Number(cfg.atTarget)).toFixed(1),
    persistentRentRateDenominator: cfg.denom,
    predicted80BytesFor518400Ledgers: { now: rent(80n, 518_400n), atTarget: rent(80n, 518_400n, cfg.atTarget) },
  }),
)

for (const h of process.argv.slice(2)) {
  const r = await server.getTransaction(h)
  if (r.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue
  const meta = r.resultMetaXdr
  const ops = meta.switch() === 4 ? meta.v4().operations() : meta.v3().operations()
  const changes = ops[0]?.changes() ?? []
  type Row = { size: number; ttl?: number; label: string }
  const before = new Map<string, Row>()
  const after = new Map<string, Row>()
  const keyOf = (e: xdr.LedgerEntryData) => {
    if (e.switch().name === 'ttl') return e.ttl().keyHash().toString('hex')
    if (e.switch().name !== 'contractData') return undefined
    const k = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: e.contractData().contract(), key: e.contractData().key(), durability: e.contractData().durability() }))
    return Buffer.from(require('node:crypto').createHash('sha256').update(k.toXDR()).digest()).toString('hex')
  }
  const label = (e: xdr.LedgerEntryData) => {
    const cd = e.contractData()
    let k: unknown
    if (cd.key().switch().name === 'scvLedgerKeyNonce') return `${cd.contract().toXDR('hex').slice(-6)} temp nonce`
    try {
      k = scValToNative(cd.key())
    } catch {
      k = cd.key().switch().name
    }
    return `${cd.contract().toXDR('hex').slice(-6)} ${cd.durability().name.slice(0, 4)} ${j(k)?.slice(0, 60)}`
  }
  for (const c of changes) {
    const t = c.switch().name
    const v = c.value()
    if (!(v instanceof xdr.LedgerEntry)) continue
    const d = v.data()
    const kh = keyOf(d)
    if (!kh) continue
    const target = t === 'ledgerEntryState' ? before : after
    const cur: Row = target.get(kh) ?? { size: 0, label: '' }
    if (d.switch().name === 'ttl') cur.ttl = d.ttl().liveUntilLedgerSeq()
    else Object.assign(cur, { size: d.toXDR().length, label: label(d) })
    target.set(kh, cur)
  }
  // Map TTL-only changes (read-only entries whose TTL was extended) back to their keys through the footprint.
  const env = r.envelopeXdr as xdr.TransactionEnvelope
  const inner = env.switch().name === 'envelopeTypeTxFeeBump' ? env.feeBump().tx().innerTx().v1().tx() : env.v1().tx()
  const fp = inner.ext().switch() === 1 ? inner.ext().sorobanData().resources().footprint() : undefined
  const hashOf = (k: xdr.LedgerKey) => Buffer.from(require('node:crypto').createHash('sha256').update(k.toXDR()).digest()).toString('hex')
  const byHash = new Map<string, xdr.LedgerKey>()
  for (const k of [...(fp?.readOnly() ?? []), ...(fp?.readWrite() ?? [])]) byHash.set(hashOf(k), k)
  for (const [kh, a] of after) {
    if (a.label) continue
    const key = byHash.get(kh)
    if (!key) continue
    const e = (await server.getLedgerEntries(key)).entries[0]
    if (!e) continue
    a.size = e.val.toXDR().length
    a.label = e.val.switch().name === 'contractData' ? label(e.val) : e.val.switch().name === 'contractCode' ? `code ${key.contractCode().hash().toString('hex').slice(0, 8)}` : e.val.switch().name
    const b = before.get(kh)
    if (b) b.size = a.size
  }
  let predicted = 0n
  for (const [kh, a] of after) {
    const b = before.get(kh)
    if (!b || a.ttl === undefined || b.ttl === undefined) continue
    const ext = BigInt(a.ttl - b.ttl)
    const grow = BigInt(Math.max(0, a.size - b.size))
    predicted += rent(BigInt(a.size), ext) + rent(grow, BigInt(b.ttl - r.ledger))
  }
  for (const [kh, a] of after) {
    const b = before.get(kh)
    if (!b || a.ttl !== undefined) continue
    const grow = BigInt(Math.max(0, a.size - b.size))
    if (grow > 0n && b.ttl !== undefined) predicted += rent(grow, BigInt(b.ttl - r.ledger))
  }
  console.log(`\n${h.slice(0, 8)} ledger ${r.ledger} feeCharged ${r.resultXdr.feeCharged().toString()}`)
  for (const [kh, a] of after) {
    const b = before.get(kh)
    const dSize = a.size && b?.size ? a.size - b.size : 0
    const dTtl = a.ttl !== undefined && b?.ttl !== undefined ? a.ttl - b.ttl : 0
    if (!dSize && !dTtl && b) continue
    console.log(`  ${(a.label || `ttl ${kh.slice(0, 8)}`).padEnd(80)} size ${b?.size ?? 'new'}→${a.size || '-'} (${dSize >= 0 ? '+' : ''}${dSize}) ttl ${b?.ttl ?? '-'}→${a.ttl ?? '-'} (+${dTtl}, remaining ${a.ttl !== undefined ? a.ttl - r.ledger : '-'})`)
  }
}
