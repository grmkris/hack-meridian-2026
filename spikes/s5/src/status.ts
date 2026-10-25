/** Print the current state: relayer, pocket G(K), smart-account USDC, rule policy. `bun src/status.ts` */
import { ACCOUNT, RULE_ID, conn, j, relayer, usdc } from './env'
import { pocketInfo, pocketUsdc, policy } from './pocket'
import { latestLedger, tokenBalance } from './signer'

const k = conn()
const out = {
  ledger: await latestLedger(),
  relayer: { id: relayer().publicKey(), ...(await pocketInfo(relayer().publicKey())) },
  pocket: { id: k.publicKey(), ...(await pocketInfo(k.publicKey())) },
  pocketUsdcRpc: await pocketUsdc(k).then(usdc, e => `n/a (${(e as Error).message.slice(0, 80)})`),
  account: { id: ACCOUNT, usdc: usdc(await tokenBalance(relayer().publicKey(), ACCOUNT)) },
  rule: await policy().then(
    p => ({ id: RULE_ID, limit: usdc(p.limit), spent: usdc(p.spent), remaining: usdc(p.remaining), period: p.period, history: p.history.map(h => `${usdc(h.amount)}@${h.ledger}`) }),
    e => ({ id: RULE_ID, error: (e as Error).message.match(/Error\(Contract, #\d+\)/)?.[0] ?? (e as Error).message.slice(0, 200) }),
  ),
}
console.log(j(out, 2))
