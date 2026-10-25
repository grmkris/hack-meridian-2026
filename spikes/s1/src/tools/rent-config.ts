import { xdr } from '@stellar/stellar-sdk'
import { server } from '../signer'
const ids = ['configSettingContractLedgerCostV0', 'configSettingStateArchival', 'configSettingContractLedgerCostExtV0', 'configSettingLiveSorobanStateSizeWindow']
for (const id of ids) {
  try {
    const key = xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: (xdr.ConfigSettingId as any)[id]() }))
    const r = await server.getLedgerEntries(key)
    const v = r.entries[0]?.val.configSetting()
    const val: any = v?.value()
    if (Array.isArray(val)) { const xs = val.map((x: any) => Number(x.toString())); console.log(id, 'n=', xs.length, 'last=', xs.at(-1), 'avg=', Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)); continue }
    const out: Record<string, string> = {}
    for (const k of Object.keys(val?._attributes ?? {})) out[k] = String(val._attributes[k])
    console.log(id, JSON.stringify(out))
  } catch (e) { console.log(id, 'ERR', (e as Error).message.slice(0, 120)) }
}
