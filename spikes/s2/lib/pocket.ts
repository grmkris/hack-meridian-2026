/**
 * Pocket model helpers (see client/pocket.ts for the walkthrough).
 *   ensurePocket(K)          relayer-sponsored G(K): 0 XLM held, USDC trustline, reserves locked by the relayer
 *   pull(K, amount)          stand-in for S1's delegated SAC transfer smart-account → G(K) (here: funder → G(K))
 *   attachPocketPull(c, K)   x402Client.onBeforePaymentCreation hook: pull exactly the price before signing
 *   closePocket(K)           sweep USDC back, drop the trustline, merge G(K) into the relayer (reserves come back)
 */
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import type { x402Client } from "@x402/core/client";
import { HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL, USDC_ISSUER, USDC_SAC, explorerTx, key } from "./env";
import { txFacts } from "./tx";

const horizon = new Horizon.Server(HORIZON_URL);
const soroban = new rpc.Server(RPC_URL);
const usdc = new Asset("USDC", USDC_ISSUER);
const ms = (t0: number) => Math.round(performance.now() - t0);
export const relayer = () => key("RELAYER", false);
export const funder = () => key("PAYER", false);

export async function balances(id: string) {
  const a = await horizon.loadAccount(id);
  return {
    xlm: a.balances.find((b) => b.asset_type === "native")?.balance,
    usdc: a.balances.find((b) => "asset_code" in b && b.asset_code === "USDC")?.balance,
    subentries: a.subentry_count,
    sponsoring: a.num_sponsoring,
    sponsored: a.num_sponsored,
  };
}

async function classic(build: (b: TransactionBuilder) => TransactionBuilder, signers: Keypair[], label: string) {
  const t0 = performance.now();
  const tx = build(new TransactionBuilder(await horizon.loadAccount(relayer().publicKey()), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }))
    .setTimeout(60)
    .build();
  tx.sign(...signers);
  const r = await horizon.submitTransaction(tx);
  const f = await txFacts(r.hash);
  console.log(`[pocket] ${label}: ${r.hash} fee ${f?.feeCharged} stroops (paid by ${f?.feeAccount?.slice(0, 6)}…), ${ms(t0)} ms ${explorerTx(r.hash)}`);
  return r.hash;
}

/** Relayer-sponsored G(K): BeginSponsoring → CreateAccount(0 XLM) → ChangeTrust(USDC) → EndSponsoring. */
export async function ensurePocket(k: Keypair) {
  try {
    return { created: false, ...(await balances(k.publicKey())) };
  } catch {}
  const createTx = await classic(
    (b) =>
      b
        .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: k.publicKey() }))
        .addOperation(Operation.createAccount({ destination: k.publicKey(), startingBalance: "0" }))
        .addOperation(Operation.changeTrust({ asset: usdc, source: k.publicKey() }))
        .addOperation(Operation.endSponsoringFutureReserves({ source: k.publicKey() })),
    [relayer(), k],
    `created G(K) ${k.publicKey()} with sponsored reserves`,
  );
  return { created: true, createTx, ...(await balances(k.publicKey())) };
}

/** A Soroban SAC transfer `from → to` signed by `from` as source (source-account auth). */
export async function sacTransfer(from: Keypair, to: string, amount: string) {
  const t0 = performance.now();
  const tx = new TransactionBuilder(await soroban.getAccount(from.publicKey()), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({
        contract: USDC_SAC,
        function: "transfer",
        args: [nativeToScVal(from.publicKey(), { type: "address" }), nativeToScVal(to, { type: "address" }), nativeToScVal(amount, { type: "i128" })],
      }),
    )
    .setTimeout(60)
    .build();
  const prepared = await soroban.prepareTransaction(tx);
  prepared.sign(from);
  const sent = await soroban.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`transfer send ${sent.status}: ${sent.errorResult?.result().switch().name}`);
  const done = await soroban.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== "SUCCESS") throw new Error(`transfer ${done.status}`);
  return { tx: sent.hash, ledger: done.ledger, ms: ms(t0) };
}

/** Stand-in for the delegated pull smart-account → G(K) (S1: `transferAs(conn, USDC, account → G(K))`). */
export const pull = (k: Keypair, amount: string) => sacTransfer(funder(), k.publicKey(), amount);

export type Pulled = Awaited<ReturnType<typeof pull>>;

/**
 * The plug-in point for `paid_resource_fetch` / `paid_mcp_call`: grant check, then pull the shortfall
 * (price − what G(K) already holds; = exactly the price when the pocket is empty) before anything is signed.
 */
export function attachPocketPull(client: x402Client, k: Keypair, onPulled: (p: Pulled | undefined) => void) {
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (r.asset !== USDC_SAC || r.network !== "stellar:testnet") return { abort: true, reason: "pocket: wrong asset/network" };
    // Product: reserve r.amount against the grant here (Durable Object), refuse → owner lane if it does not fit.
    const held = BigInt(Math.round(Number((await balances(k.publicKey())).usdc ?? 0) * 1e7));
    const need = BigInt(r.amount) - held;
    if (need <= 0n) {
      console.log(`[pocket] G(K) already holds ${held} ≥ ${r.amount}: no pull`);
      return onPulled(undefined);
    }
    const p = await pull(k, need.toString());
    console.log(`[pocket] pull ${need} (price ${r.amount}, held ${held}) → G(K): ${p.tx} ledger ${p.ledger} in ${p.ms} ms`);
    onPulled(p);
  });
}

/**
 * Revoke-time teardown: G(K) sends any USDC left back (SAC transfer; here to the funder), drops the trustline and
 * merges into the relayer, all in one classic tx with the relayer as fee source. Sponsored reserves return.
 */
export async function closePocket(k: Keypair) {
  const b = await balances(k.publicKey());
  const ops: ((tb: TransactionBuilder) => TransactionBuilder)[] = [];
  if (Number(b.usdc ?? 0) > 0)
    ops.push((tb) => tb.addOperation(Operation.payment({ destination: funder().publicKey(), asset: usdc, amount: b.usdc!, source: k.publicKey() })));
  ops.push((tb) => tb.addOperation(Operation.changeTrust({ asset: usdc, limit: "0", source: k.publicKey() })));
  ops.push((tb) => tb.addOperation(Operation.accountMerge({ destination: relayer().publicKey(), source: k.publicKey() })));
  return classic((tb) => ops.reduce((acc, f) => f(acc), tb), [relayer(), k], `closed G(K) ${k.publicKey()} (sweep ${b.usdc} USDC, drop trustline, merge)`);
}
