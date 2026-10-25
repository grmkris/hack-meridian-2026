/**
 * What a transaction declared and what it was charged, from RPC `getTransaction` (works for classic, Soroban and
 * fee-bump envelopes). Also splits the Soroban resource fee into rent / refundable / non-refundable from the meta.
 */
import { StrKey, rpc, xdr } from '@stellar/stellar-sdk'

import { server } from './signer'

export interface TxFee {
  hash: string
  ledger: number
  envelope: 'tx' | 'feeBump'
  /** outer declared max fee (fee-bump: the bump's fee), stroops */
  declaredFee: number
  /** inner tx declared fee (= declaredFee for a plain tx) */
  innerDeclaredFee: number
  /** declared Soroban resource fee (0 for classic) */
  declaredResourceFee: number
  feeCharged: number
  /** Soroban charged split, stroops (undefined for classic) */
  rent?: number
  refundable?: number
  nonRefundable?: number
  feeSource: string
  txSource: string
  ops: number
}

const muxed = (m: xdr.MuxedAccount) =>
  m.switch().name === 'keyTypeEd25519'
    ? StrKey.encodeEd25519PublicKey(m.ed25519())
    : StrKey.encodeEd25519PublicKey(m.med25519().ed25519())

export async function txFee(hash: string, tries = 20): Promise<TxFee> {
  for (let i = 0; i < tries; i++) {
    const r = await server.getTransaction(hash)
    if (r.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      await Bun.sleep(1000)
      continue
    }
    const env = r.envelopeXdr as xdr.TransactionEnvelope
    let declaredFee: number
    let innerDeclaredFee: number
    let inner: xdr.Transaction
    let feeSource: string
    let kind: TxFee['envelope']
    if (env.switch().name === 'envelopeTypeTxFeeBump') {
      const fb = env.feeBump().tx()
      kind = 'feeBump'
      declaredFee = Number(fb.fee().toString())
      inner = fb.innerTx().v1().tx()
      innerDeclaredFee = Number(inner.fee())
      feeSource = muxed(fb.feeSource())
    } else {
      kind = 'tx'
      inner = env.v1().tx()
      declaredFee = innerDeclaredFee = Number(inner.fee())
      feeSource = muxed(inner.sourceAccount())
    }
    const ext = inner.ext()
    const declaredResourceFee = ext.switch() === 1 ? Number(ext.sorobanData().resourceFee().toString()) : 0
    const out: TxFee = {
      hash,
      ledger: r.ledger,
      envelope: kind,
      declaredFee,
      innerDeclaredFee,
      declaredResourceFee,
      feeCharged: Number(r.resultXdr.feeCharged().toString()),
      feeSource,
      txSource: muxed(inner.sourceAccount()),
      ops: inner.operations().length,
    }
    try {
      const meta = r.resultMetaXdr as xdr.TransactionMeta
      const sm = meta.switch() === 4 ? meta.v4().sorobanMeta() : meta.switch() === 3 ? meta.v3().sorobanMeta() : undefined
      const e = sm?.ext()
      if (e && e.switch() === 1) {
        out.rent = Number(e.v1().rentFeeCharged().toString())
        out.refundable = Number(e.v1().totalRefundableResourceFeeCharged().toString())
        out.nonRefundable = Number(e.v1().totalNonRefundableResourceFeeCharged().toString())
      }
    } catch {}
    return out
  }
  throw new Error(`getTransaction ${hash}: not found after ${tries} s`)
}

export const xlm = (stroops: number) => (stroops / 1e7).toFixed(7)
