import type { ChainReadiness } from '@hm/protocol'
import { Address, Asset, StrKey, xdr } from '@stellar/stellar-sdk'

import { fromHex, toBuffer } from './bytes.ts'
import { USDC_CODE } from './constants.ts'

/**
 * Recipient readiness from chain state (docs/SPEC.md "Contacts and recipient readiness"): a `C…` is ready when its
 * contract instance exists; a `G…` (or the `G…` behind an `M…`) is `usdc_ready` with a USDC trustline,
 * `trustline_required` without one (claim link), `account_missing` when the account does not exist.
 */
export type AddressKind = 'contract' | 'account'

export const usdcAsset = (issuer: string): Asset => new Asset(USDC_CODE, issuer)

/** The classic account behind a `G…` or `M…`, or undefined for a contract. */
export const accountOf = (address: string): string | undefined => {
  if (StrKey.isValidEd25519PublicKey(address)) return address
  if (StrKey.isValidMed25519PublicKey(address))
    return StrKey.encodeEd25519PublicKey(StrKey.decodeMed25519PublicKey(address).subarray(0, 32))
  return undefined
}

export const isContractAddress = (address: string): boolean => StrKey.isValidContract(address)

export const accountKey = (account: string): xdr.LedgerKey =>
  xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(account)) }),
  )

export const usdcTrustlineKey = (account: string, issuer: string): xdr.LedgerKey =>
  xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(account)),
      asset: usdcAsset(issuer).toTrustLineXDRObject(),
    }),
  )

export const contractInstanceKey = (contractId: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )

/** The pure decision, from which ledger entries exist. */
export const readinessFrom = (
  kind: AddressKind,
  found: { readonly account: boolean; readonly trustline: boolean; readonly contract: boolean },
): ChainReadiness =>
  kind === 'contract'
    ? found.contract
      ? 'contract'
      : 'account_missing'
    : !found.account
      ? 'account_missing'
      : found.trustline
        ? 'usdc_ready'
        : 'trustline_required'

export const contractCodeKey = (wasmHashHex: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: toBuffer(fromHex(wasmHashHex)) }))
