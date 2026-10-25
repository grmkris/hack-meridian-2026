/**
 * One-time testnet setup for S2 (idempotent). Keys go to spikes/s2/.env; only public keys are printed.
 *   PAYER        classic G payer, USDC trustline, USDC bought on the testnet SDEX (Circle's testnet USDC)
 *   PAYTO        seller's payTo G, USDC trustline
 *   FACILITATOR  XLM-only G that signs and pays fees for the in-process facilitator
 *
 *   bun lib/setup.ts            # create/fund what is missing, print balances
 *   bun lib/setup.ts --buy 5    # buy 5 more USDC into PAYER
 */
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { HORIZON_URL, NETWORK_PASSPHRASE, USDC_ISSUER, explorerTx, key } from "./env";

const horizon = new Horizon.Server(HORIZON_URL);
const usdc = new Asset("USDC", USDC_ISSUER);

async function friendbot(kp: Keypair) {
  try {
    await horizon.loadAccount(kp.publicKey());
    return;
  } catch {}
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  console.log(`friendbot ${kp.publicKey()} -> ${r.status}`);
}

async function submit(kp: Keypair, ops: xdr.Operation[], label: string) {
  const acct = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }).setTimeout(60);
  ops.forEach((o) => b.addOperation(o));
  const tx = b.build();
  tx.sign(kp);
  const r = await horizon.submitTransaction(tx);
  console.log(`${label}: ${r.hash} ${explorerTx(r.hash)}`);
  return r.hash;
}

async function usdcLine(kp: Keypair) {
  const a = await horizon.loadAccount(kp.publicKey());
  return a.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
}

const names = ["PAYER", "PAYTO", "FACILITATOR"] as const;
const keys = Object.fromEntries(names.map((n) => [n, key(n)])) as Record<(typeof names)[number], Keypair>;
for (const n of names) await friendbot(keys[n]);
for (const n of ["PAYER", "PAYTO"] as const) {
  if (!(await usdcLine(keys[n]))) await submit(keys[n], [Operation.changeTrust({ asset: usdc })], `${n} changeTrust USDC`);
}
const buyIdx = process.argv.indexOf("--buy");
const want = buyIdx > 0 ? Number(process.argv[buyIdx + 1]) : 0;
const bal = await usdcLine(keys.PAYER);
if (want > 0 || Number(bal?.balance ?? 0) < 2) {
  const amount = String(want || 10);
  await submit(
    keys.PAYER,
    [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: "500",
        destination: keys.PAYER.publicKey(),
        destAsset: usdc,
        destAmount: amount,
        path: [],
      }),
    ],
    `PAYER buys ${amount} USDC on SDEX`,
  );
}
for (const n of names) {
  const b = await horizon
    .loadAccount(keys[n].publicKey())
    .then((a) => a.balances.map((x) => `${"asset_code" in x ? x.asset_code : "XLM"}=${x.balance}`).join(" "))
    .catch(() => "(not funded)");
  console.log(`${n.padEnd(11)} ${keys[n].publicKey()} ${b}`);
}
