/**
 * The "pocket" model, simulated end to end on testnet:
 *   connection key K = an Ed25519 signer on the smart account's spending-limit rule (S1) AND the key of its own
 *   classic account G(K). For an x402 purchase: GET → 402 → [grant check] → K pulls exactly the price from the smart
 *   account into G(K) (S1 proves that SAC transfer under the policy; here a plain SAC transfer from our funder stands
 *   in for it) → G(K) pays the seller with the stock @x402/stellar client through a hosted facilitator.
 *
 *   bun client/pocket.ts [seller url]     # default: our seller on :4021 (x402.org); :4024 = OZ Channels seller
 *
 * G(K) is created with relayer-sponsored reserves (CAP-33), so it holds 0 XLM: the relayer locks the 1 XLM account
 * reserve + 0.5 XLM trustline reserve, the facilitator pays the settlement fee, the relayer/funder pays the pull fee.
 * Prints the two-step receipt {pull, settlement} with hashes, fees and per-step latency.
 */
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL, SELLER_URL, USDC_ISSUER, USDC_SAC, explorerTx, key } from "../lib/env";
import { txFacts } from "../lib/tx";
import { buildClient } from "./pay";

const url = process.argv.slice(2).find((a) => a.startsWith("http")) ?? `${SELLER_URL}/paid/quote`;
const horizon = new Horizon.Server(HORIZON_URL);
const soroban = new rpc.Server(RPC_URL);
const usdc = new Asset("USDC", USDC_ISSUER);
const relayer = key("RELAYER", false);
const funder = key("PAYER", false); // stands in for the smart account in the pull
const pocket = key("POCKET"); // K
const ms = (t0: number) => Math.round(performance.now() - t0);

async function balances(id: string) {
  const a = await horizon.loadAccount(id);
  return {
    xlm: a.balances.find((b) => b.asset_type === "native")?.balance,
    usdc: a.balances.find((b) => "asset_code" in b && b.asset_code === "USDC")?.balance,
    subentries: a.subentry_count,
    sponsoring: a.num_sponsoring,
    sponsored: a.num_sponsored,
  };
}

/** Relayer-sponsored G(K): BeginSponsoring → CreateAccount(0 XLM) → ChangeTrust(USDC) → EndSponsoring. */
async function ensurePocket() {
  try {
    return { created: false, ...(await balances(pocket.publicKey())) };
  } catch {}
  const t0 = performance.now();
  const tx = new TransactionBuilder(await horizon.loadAccount(relayer.publicKey()), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: pocket.publicKey() }))
    .addOperation(Operation.createAccount({ destination: pocket.publicKey(), startingBalance: "0" }))
    .addOperation(Operation.changeTrust({ asset: usdc, source: pocket.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: pocket.publicKey() }))
    .setTimeout(60)
    .build();
  tx.sign(relayer, pocket);
  const r = await horizon.submitTransaction(tx);
  const facts = await txFacts(r.hash);
  console.log(`[pocket] created G(K) ${pocket.publicKey()} with sponsored reserves: ${r.hash} fee ${facts?.feeCharged} stroops, ${ms(t0)} ms ${explorerTx(r.hash)}`);
  return { created: true, createTx: r.hash, ...(await balances(pocket.publicKey())) };
}

/** Stand-in for S1's delegated pull: SAC transfer(funder → G(K), amount), a Soroban invocation like the real one. */
async function pull(amount: string) {
  const t0 = performance.now();
  const tx = new TransactionBuilder(await soroban.getAccount(funder.publicKey()), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({
        contract: USDC_SAC,
        function: "transfer",
        args: [nativeToScVal(funder.publicKey(), { type: "address" }), nativeToScVal(pocket.publicKey(), { type: "address" }), nativeToScVal(amount, { type: "i128" })],
      }),
    )
    .setTimeout(60)
    .build();
  const prepared = await soroban.prepareTransaction(tx);
  prepared.sign(funder);
  const sent = await soroban.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`pull send ${sent.status}: ${sent.errorResult?.result().switch().name}`);
  const done = await soroban.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== "SUCCESS") throw new Error(`pull ${done.status}`);
  return { tx: sent.hash, ledger: done.ledger, ms: ms(t0) };
}

const before = await ensurePocket();
console.log(`[pocket] G(K) before: ${JSON.stringify(before)}`);
const base = await horizon.ledgers().order("desc").limit(1).call();
console.log(`[pocket] base_reserve ${base.records[0]!.base_reserve_in_stroops} stroops → unsponsored G(K) would need (2 + 1 trustline) × 0.5 = 1.5 XLM locked`);

const { client } = buildClient({ payerSecret: pocket.secret() });
let pulled: Awaited<ReturnType<typeof pull>> | undefined;
client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
  // Product: grant check + reservation happen here (amount ≤ remaining, asset = USDC SAC, network, payTo policy).
  if (r.asset !== USDC_SAC || r.network !== "stellar:testnet") return { abort: true, reason: "pocket: wrong asset/network" };
  pulled = await pull(r.amount);
  console.log(`[pocket] pull ${r.amount} → G(K): ${pulled.tx} ledger ${pulled.ledger} in ${pulled.ms} ms`);
});

const t0 = performance.now();
const res = await wrapFetchWithPayment(fetch, client)(url);
const total = ms(t0);
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
