/**
 * The "pocket" model, simulated end to end on testnet:
 *   connection key K = an Ed25519 signer on the smart account's spending-limit rule (S1) AND the key of its own
 *   classic account G(K). For an x402 purchase: GET → 402 → [grant check] → K pulls exactly the price from the smart
 *   account into G(K) (S1 proves that SAC transfer under the policy; here a plain SAC transfer from our funder stands
 *   in for it) → G(K) pays the seller with the stock @x402/stellar client through a hosted facilitator.
 *
 *   bun client/pocket.ts [seller url]            # default: our seller on :4021 (x402.org); :4024 = OZ Channels seller
 *   bun client/pocket.ts --fresh --close         # use a new K, then tear the pocket down (reserves back to relayer)
 *   bun client/pocket.ts --id pay_…              # attach a payment-identifier (seller-side dedup)
 *
 * G(K) is created with relayer-sponsored reserves (CAP-33), so it holds 0 XLM: the relayer locks the 1 XLM account
 * reserve + 0.5 XLM trustline reserve, the facilitator pays the settlement fee, the relayer/funder pays the pull fee.
 * Prints the two-step receipt {pull, settlement} with hashes, fees and per-step latency.
 */
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { HORIZON_URL, SELLER_URL, explorerTx, key } from "../lib/env";
import { attachPocketPull, balances, closePocket, ensurePocket, relayer } from "../lib/pocket";
import type { Pulled } from "../lib/pocket";
import { txFacts } from "../lib/tx";
import { buildClient } from "./pay";

const url = process.argv.slice(2).find((a) => a.startsWith("http")) ?? `${SELLER_URL}/paid/quote`;
const pocket = process.argv.includes("--fresh") ? Keypair.random() : key("POCKET");
const horizon = new Horizon.Server(HORIZON_URL);

const relayerBefore = await balances(relayer().publicKey());
const before = await ensurePocket(pocket);
console.log(`[pocket] G(K) before: ${JSON.stringify(before)}`);
const base = await horizon.ledgers().order("desc").limit(1).call();
console.log(`[pocket] base_reserve ${base.records[0]!.base_reserve_in_stroops} stroops → unsponsored G(K) would need (2 + 1 trustline) × 0.5 = 1.5 XLM locked`);

const idIdx = process.argv.indexOf("--id");
const { client } = buildClient({ payerSecret: pocket.secret(), paymentId: idIdx > 0 ? process.argv[idIdx + 1] : undefined });
let pulled: Pulled | undefined;
attachPocketPull(client, pocket, (p) => (pulled = p));

const t0 = performance.now();
const res = await wrapFetchWithPayment(fetch, client)(url);
const total = Math.round(performance.now() - t0);
const body = await res.text();
const settle = res.headers.get("payment-response") ? new x402HTTPClient(client).getPaymentSettleResponse((h) => res.headers.get(h)) : undefined;
const [pullFacts, settleFacts] = await Promise.all([pulled && txFacts(pulled.tx), settle?.transaction ? txFacts(settle.transaction) : undefined]);
const receipt = {
  resource: url,
  status: res.status,
  body: body.slice(0, 200),
  totalMs: total,
  pull: pulled && { tx: pulled.tx, ledger: pulled.ledger, ms: pulled.ms, feeCharged: pullFacts?.feeCharged, feeAccount: pullFacts?.feeAccount, link: explorerTx(pulled.tx) },
  settlement: settle && { ...settle, ledger: settleFacts?.ledger, feeCharged: settleFacts?.feeCharged, feeAccount: settleFacts?.feeAccount, link: settle.transaction ? explorerTx(settle.transaction) : undefined },
  pocketAfter: await balances(pocket.publicKey()),
};
console.log(`[pocket] receipt ${JSON.stringify(receipt, null, 2)}`);

if (process.argv.includes("--close")) {
  await closePocket(pocket);
  const gone = await balances(pocket.publicKey()).then(() => "still exists", () => "merged (404)");
  const relayerAfter = await balances(relayer().publicKey());
  console.log(`[pocket] G(K) after close: ${gone}; relayer XLM ${relayerBefore.xlm} → ${relayerAfter.xlm}, sponsoring ${relayerBefore.sponsoring} → ${relayerAfter.sponsoring}`);
}
