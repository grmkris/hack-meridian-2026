import {
  FUNDING,
  ROLE_LIST,
  accountState,
  aliceId,
  contractExists,
  explorerAddress,
  publicKey,
  routerId,
  xlm,
} from './lib.ts'

/**
 * Verify funding (M2): each mainnet account's XLM and USDC against docs/mainnet-funding.md, plus whether the router
 * (M3) and Alice's smart account (M5) exist yet. Read-only (RPC getLedgerEntries); exits 1 while anything is short.
 *
 *   bun scripts/mainnet/balances.ts
 */
let short = 0
console.log(
  '| role     | address                                                  | XLM have / need | USDC have / need | status',
)
console.log(
  '| -------- | -------------------------------------------------------- | --------------- | ---------------- | ------',
)
for (const role of ROLE_LIST) {
  const need = FUNDING[role]
  const s = await accountState(publicKey(role))
  const xlmOk = s.exists && s.xlm >= BigInt(need.xlm) * 10_000_000n
  const usdcOk = need.usdc === 0 || (s.usdc !== null && s.usdc >= BigInt(need.usdc) * 10_000_000n)
  const status = !s.exists
    ? 'not funded'
    : !xlmOk
      ? 'XLM short'
      : !usdcOk
        ? s.usdc === null
          ? 'needs the USDC trustline first (seed.ts --only trustlines), then USDC'
          : 'USDC short'
        : role === 'carol' && s.usdc !== null
          ? 'has a trustline: the claim-link beat needs none'
          : 'ok'
  if (status !== 'ok') short++
  const usdc = s.usdc === null ? 'no trustline' : Number(xlm(s.usdc)).toFixed(2)
  console.log(
    `| ${role.padEnd(8)} | ${s.address} | ${`${s.exists ? Number(xlm(s.xlm)).toFixed(2) : '-'} / ${need.xlm}`.padEnd(15)} | ${`${usdc} / ${need.usdc}`.padEnd(16)} | ${status}`,
  )
}
for (const [name, id] of [
  ['router (M3)', routerId()],
  ['Alice (M5)', aliceId()],
] as const)
  console.log(`${name}: ${id} ${(await contractExists(id)) ? 'deployed' : 'not deployed yet'} ${explorerAddress(id)}`)
process.exit(short === 0 ? 0 : 1)
