/** Fee breakdown for tx hashes: bun src/tools/fees.ts <hash>… (reads sorobanMeta from RPC getTransaction). */
import { rpc, xdr } from '@stellar/stellar-sdk'

import { server } from '../signer'

for (const h of process.argv.slice(2)) {
  const r = await server.getTransaction(h)
  if (r.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    console.log(h, 'NOT_FOUND')
    continue
  }
  const meta = r.resultMetaXdr
  const v = meta.switch()
  const sm = v === 4 ? meta.v4().sorobanMeta() : v === 3 ? meta.v3().sorobanMeta() : undefined
  const ext = sm?.ext()
  const fee =
    ext && ext.switch() === 1
      ? {
          nonRefundable: ext.v1().totalNonRefundableResourceFeeCharged().toString(),
          refundable: ext.v1().totalRefundableResourceFeeCharged().toString(),
          rent: ext.v1().rentFeeCharged().toString(),
        }
      : {}
  const env = r.envelopeXdr.v1().tx()
  const sd = env.ext().value() as xdr.SorobanTransactionData
  const res = sd.resources()
  const changes = (v === 4 ? meta.v4().operations()[0]?.changes() : meta.v3().operations()[0]?.changes()) ?? []
  const created = changes.filter(c => c.switch().name === 'ledgerEntryCreated').length
  const updated = changes.filter(c => c.switch().name === 'ledgerEntryUpdated').length
  console.log(
    JSON.stringify({
      hash: h.slice(0, 12),
      status: r.status,
      feeCharged: r.resultXdr.feeCharged().toString(),
      declaredResourceFee: sd.resourceFee().toString(),
      ...fee,
      instructions: res.instructions(),
      readBytes: res.diskReadBytes(),
      writeBytes: res.writeBytes(),
      ro: res.footprint().readOnly().length,
      rw: res.footprint().readWrite().length,
      created,
      updated,
    }),
  )
}
