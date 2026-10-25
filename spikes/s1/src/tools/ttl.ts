/** TTL/entry changes in a tx: bun src/tools/ttl.ts <hash> */
import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

import { server } from '../signer'

const h = process.argv[2]!
const r = await server.getTransaction(h)
if (r.status === rpc.Api.GetTransactionStatus.NOT_FOUND) throw new Error('not found')
const meta = r.resultMetaXdr
const ops = meta.switch() === 4 ? meta.v4().operations() : meta.v3().operations()
const latest = r.ledger
const describe = (e: xdr.LedgerEntryData) => {
  const n = e.switch().name
  if (n === 'contractData') {
    const cd = e.contractData()
    let k: unknown
    try {
      k = scValToNative(cd.key())
    } catch {
      k = cd.key().switch().name
    }
    return `data ${cd.contract().toXDR('hex').slice(-8)} ${cd.durability().name} key=${JSON.stringify(k, (_x, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 80)} size=${e.toXDR().length}`
  }
  if (n === 'ttl') return `ttl liveUntil=${e.ttl().liveUntilLedgerSeq()} (+${e.ttl().liveUntilLedgerSeq() - latest} ledgers ≈ ${((e.ttl().liveUntilLedgerSeq() - latest) / 17280).toFixed(1)} d)`
  return n
}
for (const c of ops[0]?.changes() ?? []) {
  const t = c.switch().name
  const v = c.value() as xdr.LedgerEntry | xdr.LedgerKey
  if (v instanceof xdr.LedgerEntry) console.log(t.padEnd(20), describe(v.data()))
}
