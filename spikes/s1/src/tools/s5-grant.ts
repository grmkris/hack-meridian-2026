/** Leave a funded account with a live 5 USDC / ~1 day grant for S5: bun src/tools/s5-grant.ts <C-account> <usdc-to-fund> */
import { Keypair } from '@stellar/stellar-sdk'

import { LEDGERS_PER_DAY, USDC, USDC_SAC, addConnectionRule, addr, ed25519Signer, i128, invokeAs, latestLedger, readSpendingLimit, tokenBalance } from '../signer'

const [account, fundArg] = process.argv.slice(2)
if (!account) throw new Error('usage: s5-grant.ts <C-account> [usdc]')
const sponsor = Keypair.fromSecret(process.env.SPONSOR_SECRET!)
const funder = Keypair.fromSecret(process.env.FUNDER_SECRET!)
const owner = ed25519Signer(Keypair.fromSecret(process.env.OWNER_SECRET!), 'owner')
const conn = ed25519Signer(Keypair.fromSecret(process.env.CONN_SECRET!), 'conn')
if (Number(fundArg ?? 0) > 0) {
  const f = await invokeAs(funder, funder.publicKey(), [], [], USDC_SAC, 'transfer', [addr(funder.publicKey()), addr(account), i128(USDC(Number(fundArg)))])
  console.log(`fund ${fundArg} USDC: ${f.hash}`)
}
const now = await latestLedger()
const r = await addConnectionRule(sponsor, account, owner, {
  token: USDC_SAC,
  connection: conn,
  name: 's5-grant',
  spendingLimit: USDC(5),
  periodLedgers: LEDGERS_PER_DAY + 720,
  validUntilLedger: now + LEDGERS_PER_DAY,
})
console.log(`rule ${r.ruleId} valid_until=${now + LEDGERS_PER_DAY}: ${r.hash}`)
console.log(JSON.stringify(await readSpendingLimit(sponsor.publicKey(), account, r.ruleId), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
console.log(`balance ${Number(await tokenBalance(sponsor.publicKey(), account)) / 1e7} USDC`)
