/**
 * Fee A/B on a warm grant: identical pulls into the pocket, A = 0 stroops (policy returns before writing),
 * B = 0.1 USDC (policy appends one 80-byte SpendingEntry). Prints record-sim vs enforce-sim vs declared vs charged,
 * and the rent predicted from the live network config. bun src/tools/fee-ab.ts <C-account> <ruleId>
 */
import { Keypair, xdr } from '@stellar/stellar-sdk'

import { USDC, pullToPocket, server, type TxReport } from '../signer'

const [account, rule] = process.argv.slice(2)
if (!account || !rule) throw new Error('usage: fee-ab.ts <C-account> <ruleId>')
const relayer = Keypair.fromSecret(process.env.SPONSOR_SECRET!)
const conn = Keypair.fromSecret(process.env.CONN_SECRET!)

async function config() {
  const get = async (id: string) => {
    const key = xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({ configSettingId: (xdr.ConfigSettingId as any)[id]() }),
    )
    return (await server.getLedgerEntries(key)).entries[0]!.val.configSetting().value() as any
  }
  const cost = await get('configSettingContractLedgerCostV0')
  const arch = await get('configSettingStateArchival')
  const window = (await get('configSettingLiveSorobanStateSizeWindow')) as any[]
  const size = window.map(x => BigInt(x.toString())).reduce((a, b) => a + b, 0n) / BigInt(window.length)
  const low = BigInt(cost.rentFee1KbSorobanStateSizeLow().toString())
  const high = BigInt(cost.rentFee1KbSorobanStateSizeHigh().toString())
  const target = BigInt(cost.sorobanStateTargetSizeBytes().toString())
  const growth = BigInt(cost.sorobanStateRentFeeGrowthFactor())
  const mult = high - low
  // soroban-env-host compute_rent_write_fee_per_1kb (protocol >= 23)
  let fee1kb = (mult * size + target - 1n) / target + low
  if (size > target) fee1kb += (mult * growth * (size - target) + target - 1n) / target
  if (fee1kb < 1000n) fee1kb = 1000n
  const atTarget = mult + low
  return { size, target, fee1kb, atTarget, denom: BigInt(arch.persistentRentRateDenominator()) }
}
const rent = (bytes: bigint, ledgers: bigint, fee1kb: bigint, denom: bigint) => (bytes * fee1kb * ledgers) / (1024n * denom)

const cfg = await config()
console.log(
  `network: live soroban state ${cfg.size} B vs target ${cfg.target} B (${((Number(cfg.size) / Number(cfg.target) - 1) * 100).toFixed(3)} % over) → rent fee ${cfg.fee1kb} stroops/KB (at target: ${cfg.atTarget}); persistentRentRateDenominator ${cfg.denom}`,
)
const show = (tag: string, r: TxReport) =>
  console.log(
    `${tag} ${r.hash} ledger=${r.ledger}\n   recordSim minResourceFee=${r.timings.recordSimMinResourceFee}  enforceSim minResourceFee=${r.timings.enforceSimMinResourceFee}  declared resourceFee=${r.resourceFee} maxFee=${r.maxFee}\n   feeCharged=${r.feeCharged}  nonRefundable=${r.feeBreakdown?.nonRefundable} refundable=${r.feeBreakdown?.refundable} rent=${r.feeBreakdown?.rent}\n   ${r.explorer}`,
  )
const a = await pullToPocket(relayer, account, conn, Number(rule), 0n, { label: 'A: pull 0 (no policy write)' })
show('A pull 0 stroops  ', a)
const b = await pullToPocket(relayer, account, conn, Number(rule), USDC(0.1), { label: 'B: pull 0.1 USDC' })
show('B pull 0.1 USDC   ', b)
const ttlLedgers = 30n * 17280n // policy extends its entry to 30 days; remaining ≈ that minus elapsed
console.log(
  `predicted rent for +80 B over ≤ ${ttlLedgers} ledgers: ${rent(80n, ttlLedgers, cfg.fee1kb, cfg.denom)} stroops now; ${rent(80n, ttlLedgers, cfg.atTarget, cfg.denom)} at target; ${rent(80n, ttlLedgers, 1000n, cfg.denom)} at the 1000/KB floor`,
)
