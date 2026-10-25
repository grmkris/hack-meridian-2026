/**
 * TTL of the shared contracts every delegated payment touches (instance + WASM), and the archival settings.
 * Anyone may extend these with ExtendFootprintTTL; nobody owns the job. bun src/tools/shared-ttl.ts
 */
import { Address, xdr } from '@stellar/stellar-sdk'

import { ACCOUNT, j } from '../env'
import { ED25519_VERIFIER, SPENDING_LIMIT_POLICY, USDC_SAC, latestLedger, server } from '../signer'

const latest = await latestLedger()
const arch = (
  await server.getLedgerEntries(xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival() })))
).entries[0]!.val
  .configSetting()
  .stateArchivalSettings()
const out: Record<string, unknown> = {
  latest,
  minPersistentTtl: arch.minPersistentTtl(),
  minTemporaryTtl: arch.minTemporaryTtl(),
  maxEntryTtl: arch.maxEntryTtl(),
}
for (const [name, id] of [
  ['spending-limit policy', SPENDING_LIMIT_POLICY],
  ['ed25519 verifier', ED25519_VERIFIER],
  ['smart account', ACCOUNT],
  ['USDC SAC', USDC_SAC],
] as const) {
  const instKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract: new Address(id).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }),
  )
  const inst = (await server.getLedgerEntries(instKey)).entries[0]
  const exec = inst?.val.contractData().val().instance().executable()
  const row: Record<string, unknown> = { instanceLiveUntil: inst?.liveUntilLedgerSeq, instanceHoursLeft: inst?.liveUntilLedgerSeq ? (((inst.liveUntilLedgerSeq - latest) * 5) / 3600).toFixed(1) : undefined }
  if (exec?.switch().name === 'contractExecutableWasm') {
    const code = (await server.getLedgerEntries(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: exec.wasmHash() })))).entries[0]
    Object.assign(row, { wasm: exec.wasmHash().toString('hex').slice(0, 8), wasmBytes: code?.val.toXDR().length, wasmLiveUntil: code?.liveUntilLedgerSeq, wasmHoursLeft: code?.liveUntilLedgerSeq ? (((code.liveUntilLedgerSeq - latest) * 5) / 3600).toFixed(1) : undefined })
  }
  out[name] = row
}
console.log(j(out, 2))
