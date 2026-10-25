/**
 * The pocket G(K) and the moves between it and the smart account, all with the S5 relayer as source and fee payer:
 *   pocketInfo(K)                Horizon view: XLM, USDC, reserves, sponsorship
 *   recreateSponsored(K)         merge an existing (friendbot-funded) G(K) into the relayer, then recreate it with
 *                                relayer-sponsored reserves and a USDC trustline (S2's shape: 0 XLM in the pocket)
 *   pull(K, amount)              K pulls `amount` from the smart account into G(K) under its rule (S1 transferAs)
 *   sweep(K, to)                 Soroban SAC transfer G(K) → C: relayer is the source, K signs only the address auth
 *   closePocket(K)               drop the trustline and merge G(K) into the relayer (sponsored reserves come back)
 *   policy()                     get_spending_limit_data for the rule + remaining
 */
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder, authorizeEntry } from '@stellar/stellar-sdk'

import { ACCOUNT, HORIZON_URL, RULE_ID, explorerTx, ms, relayer } from './env'
import {
  NETWORK_PASSPHRASE,
  USDC_ISSUER,
  USDC_SAC,
  addr,
  ed25519Signer,
  finalizeInvocation,
  i128,
  prepareInvocation,
  readSpendingLimit,
  tokenBalance,
  transferAs,
} from './signer'
import type { TxReport } from './signer'

export const horizon = new Horizon.Server(HORIZON_URL)
const usdcAsset = new Asset('USDC', USDC_ISSUER)

export async function pocketInfo(id: string) {
  try {
    const a = await horizon.loadAccount(id)
    return {
      exists: true,
      xlm: a.balances.find(b => b.asset_type === 'native')?.balance,
      usdc: a.balances.find(b => 'asset_code' in b && b.asset_code === 'USDC')?.balance,
      subentries: a.subentry_count,
      numSponsored: a.num_sponsored,
      numSponsoring: a.num_sponsoring,
      sponsor: (a as unknown as { sponsor?: string }).sponsor,
    }
  } catch {
    return { exists: false as const }
  }
}

export interface ClassicReport {
  label: string
  hash: string
  ms: number
  explorer: string
}

async function classic(label: string, build: (b: TransactionBuilder) => TransactionBuilder, signers: Keypair[]): Promise<ClassicReport> {
  const t0 = performance.now()
  const rel = relayer()
  const tx = build(new TransactionBuilder(await horizon.loadAccount(rel.publicKey()), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }))
    .setTimeout(60)
    .build()
  tx.sign(...signers)
  const r = await horizon.submitTransaction(tx)
  const out = { label, hash: r.hash, ms: ms(t0), explorer: explorerTx(r.hash) }
  console.log(`[pocket] ${label}: ${r.hash} ${out.ms} ms`)
  return out
}

/** Merge an existing G(K) (must hold 0 USDC) into the relayer. */
export const mergeIntoRelayer = (k: Keypair, label = `close G(K) ${k.publicKey().slice(0, 6)}: trustline 0 + merge`) =>
  classic(
    label,
    b =>
      b
        .addOperation(Operation.changeTrust({ asset: usdcAsset, limit: '0', source: k.publicKey() }))
        .addOperation(Operation.accountMerge({ destination: relayer().publicKey(), source: k.publicKey() })),
    [relayer(), k],
  )

/** BeginSponsoring → CreateAccount(0 XLM) → ChangeTrust(USDC) → EndSponsoring, one relayer tx. */
export const createSponsored = (k: Keypair) =>
  classic(
    `create G(K) ${k.publicKey().slice(0, 6)} with sponsored reserves + USDC trustline`,
    b =>
      b
        .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: k.publicKey() }))
        .addOperation(Operation.createAccount({ destination: k.publicKey(), startingBalance: '0' }))
        .addOperation(Operation.changeTrust({ asset: usdcAsset, source: k.publicKey() }))
        .addOperation(Operation.endSponsoringFutureReserves({ source: k.publicKey() })),
    [relayer(), k],
  )

export const pocketUsdc = (k: Keypair) => tokenBalance(relayer().publicKey(), k.publicKey())

/** K pulls `amount` (stroops) from the smart account into G(K) under RULE_ID. Throws InvokeError on refusal. */
export const pull = (k: Keypair, amount: bigint, label = `pull ${amount} → G(K)`) =>
  transferAs(relayer(), ACCOUNT, ed25519Signer(k, 'conn'), RULE_ID, k.publicKey(), amount, { label })

/** Delegated payment to a person straight from the smart account under the same rule (one tx). */
export const payFromAccount = (k: Keypair, to: string, amount: bigint, label = `delegated pay ${amount} → ${to.slice(0, 6)}`) =>
  transferAs(relayer(), ACCOUNT, ed25519Signer(k, 'conn'), RULE_ID, to, amount, { label })

/** Sweep G(K)'s USDC back to the smart account: Soroban SAC transfer, relayer source + fees, K signs the address auth. */
export async function sweep(k: Keypair, amount: bigint, to = ACCOUNT, label = `sweep ${amount} G(K) → C`): Promise<TxReport> {
  const rel = relayer()
  const prep = await prepareInvocation(rel, USDC_SAC, 'transfer', [addr(k.publicKey()), addr(to), i128(amount)])
  const t0 = performance.now()
  const signed = await Promise.all(
    prep.entries.map(e =>
      e.credentials().switch().name === 'sorobanCredentialsSourceAccount' ? e : authorizeEntry(e, k, prep.validUntilLedger, NETWORK_PASSPHRASE),
    ),
  )
  prep.timings.sign = ms(t0)
  return finalizeInvocation(rel, prep, signed, label)
}

export async function policy() {
  const d = await readSpendingLimit(relayer().publicKey(), ACCOUNT, RULE_ID)
  const limit = BigInt(d.spending_limit)
  const spent = BigInt(d.cached_total_spent)
  return {
    limit,
    spent,
    remaining: limit - spent,
    period: d.period_ledgers,
    history: d.spending_history.map(h => ({ amount: BigInt(h.amount), ledger: h.ledger_sequence })),
  }
}
