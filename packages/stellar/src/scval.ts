import { Address, xdr } from '@stellar/stellar-sdk'

import { toBuffer, utf8 } from './bytes.ts'

/** ScVal builders for the OpenZeppelin smart account's types (shapes proven in spike S1). */
export const addr = (a: string): xdr.ScVal => new Address(a).toScVal()
export const i128 = (n: bigint): xdr.ScVal =>
  xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString((n >> 64n).toString()),
      lo: xdr.Uint64.fromString((n & 0xffff_ffff_ffff_ffffn).toString()),
    }),
  )
export const u32 = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n)
export const u32Vec = (ids: ReadonlyArray<number>): xdr.ScVal => xdr.ScVal.scvVec(ids.map(i => xdr.ScVal.scvU32(i)))
export const str = (s: string): xdr.ScVal => xdr.ScVal.scvString(s)
export const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s)
export const bytes = (b: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(toBuffer(b))
export const mapEntry = (key: xdr.ScVal, val: xdr.ScVal): xdr.ScMapEntry => new xdr.ScMapEntry({ key, val })
/** `Option<T>`: `Some(x)` is the bare value, `None` is void. */
export const option = (v: xdr.ScVal | undefined): xdr.ScVal => v ?? xdr.ScVal.scvVoid()

/** `Signer::External(verifier, key_data)` */
export const externalSigner = (verifier: string, keyData: Uint8Array): xdr.ScVal =>
  xdr.ScVal.scvVec([sym('External'), addr(verifier), bytes(keyData)])

/** `ContextRuleType::CallContract(contract)` */
export const callContractRule = (contract: string): xdr.ScVal => xdr.ScVal.scvVec([sym('CallContract'), addr(contract)])

/** `SpendingLimitAccountParams { period_ledgers: u32, spending_limit: i128 }` (fields in key order). */
export const spendingLimitParams = (spendingLimit: bigint, periodLedgers: number): xdr.ScVal =>
  xdr.ScVal.scvMap([
    mapEntry(sym('period_ledgers'), u32(periodLedgers)),
    mapEntry(sym('spending_limit'), i128(spendingLimit)),
  ])

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Host ordering for ScMap keys (Smart Account Kit's `compareScVal`, for our key shapes): the host compares Vec, Bytes
 * and Symbol element-wise by content, not by their length-prefixed XDR.
 */
export const compareScVal = (a: xdr.ScVal, b: xdr.ScVal): number => {
  const at = a.switch().value
  const bt = b.switch().value
  if (at !== bt) return at < bt ? -1 : 1
  switch (a.switch().name) {
    case 'scvVec': {
      const av = a.vec() ?? []
      const bv = b.vec() ?? []
      for (let i = 0; i < Math.min(av.length, bv.length); i++) {
        const x = av[i]
        const y = bv[i]
        if (x === undefined || y === undefined) break
        const c = compareScVal(x, y)
        if (c !== 0) return c
      }
      return av.length - bv.length
    }
    case 'scvSymbol':
      return compareBytes(utf8(a.sym().toString()), utf8(b.sym().toString()))
    case 'scvBytes':
      return compareBytes(a.bytes(), b.bytes())
    case 'scvAddress':
      return compareBytes(a.address().toXDR(), b.address().toXDR())
    default:
      return compareBytes(a.toXDR(), b.toXDR())
  }
}

/** The invokeHostFunction body for `contract.fn(args)`. */
export const invokeContractFunc = (contract: string, fn: string, args: ReadonlyArray<xdr.ScVal>): xdr.HostFunction =>
  xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: fn,
      args: [...args],
    }),
  )
