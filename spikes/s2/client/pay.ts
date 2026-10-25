/**
 * S2 classic payer: pays an x402 Stellar route from a G account with the stock @x402/stellar client scheme.
 *
 *   bun client/pay.ts [url]                      # pay once (default: our seller /paid/quote)
 *   bun client/pay.ts [url] --id pay_xxx         # attach a payment-identifier (dedup step)
 *   bun client/pay.ts [url] --cap '$0.05'        # spend control; the $0.10 route must be refused before signing
 *   bun client/pay.ts [url] --scheme ours        # use spikes/s2/scheme (our SchemeNetworkClient, G signer)
 *
 * Prints status, body, the decoded PAYMENT-RESPONSE (settle response), tx hash, explorer link and fee charged.
 * The raw PAYMENT-SIGNATURE header is written to .logs/last-payment-signature.txt for the replay test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { appendPaymentIdentifierToExtensions, generatePaymentId } from "@x402/extensions/payment-identifier";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { NETWORK, RPC_URL, SELLER_URL, secret } from "../lib/env";
import { txFacts } from "../lib/tx";
import { SmartAccountExactStellarScheme, ed25519SignatureScVal } from "../scheme";
import { Keypair } from "@stellar/stellar-sdk";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a) => a.startsWith("http")) ?? `${SELLER_URL}/paid/quote`;
const paymentId = args.includes("--new-id") ? generatePaymentId() : flag("--id");
const cap = flag("--cap");
const which = flag("--scheme") ?? "stock";
const LOGS = join(import.meta.dir, "..", ".logs");
mkdirSync(LOGS, { recursive: true });

export function buildClient(opts: { cap?: string; paymentId?: string; scheme?: string } = {}) {
  const payerSecret = secret("PAYER");
  const scheme =
    opts.scheme === "ours"
      ? (() => {
          const kp = Keypair.fromSecret(payerSecret);
          return new SmartAccountExactStellarScheme(
            { address: kp.publicKey(), signPayload: async (payloadHash) => ed25519SignatureScVal(kp, payloadHash) },
            { url: RPC_URL },
          );
        })()
      : new ExactStellarScheme(createEd25519Signer(payerSecret, NETWORK), { url: RPC_URL });
  const client = new x402Client().register("stellar:*", scheme);
  if (opts.cap) client.setSpendControls({ maxAmountPerPayment: opts.cap });
  let signed = 0;
  client.onBeforePaymentCreation(async (ctx) => {
    const r = ctx.selectedRequirements;
    console.log(`[client] 402 accepted: ${r.amount} of ${r.asset} → ${r.payTo} on ${r.network} (maxTimeout ${r.maxTimeoutSeconds}s)`);
    if (opts.paymentId) {
      ctx.paymentRequired.extensions ??= {};
      appendPaymentIdentifierToExtensions(ctx.paymentRequired.extensions, opts.paymentId);
      console.log(`[client] payment-identifier ${opts.paymentId}`);
    }
  });
  client.onAfterPaymentCreation(async () => {
    signed++;
  });
  return { client, signedCount: () => signed };
}

if (import.meta.main) {
  const { client, signedCount } = buildClient({ cap, paymentId, scheme: which });
  let sentHeader: string | undefined;
  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const h = req.headers.get("payment-signature");
    if (h) sentHeader = h;
    return fetch(req);
  }) as typeof fetch;
  const pay = wrapFetchWithPayment(recordingFetch, client);
  const t0 = performance.now();
  try {
    const res = await pay(url, { method: "GET" });
    const ms = (performance.now() - t0).toFixed(0);
    const body = await res.text();
    console.log(`[client] ${res.status} in ${ms} ms (scheme=${which}, signatures created=${signedCount()}) cache=${res.headers.get("x-s2-cache") ?? "-"}`);
    console.log(`[client] body: ${body.slice(0, 400)}`);
    if (sentHeader) {
      writeFileSync(join(LOGS, "last-payment-signature.txt"), sentHeader);
      const decoded = JSON.parse(Buffer.from(sentHeader, "base64").toString());
      writeFileSync(join(LOGS, "last-payment-payload.json"), JSON.stringify(decoded, null, 2));
      console.log(`[client] sent PAYMENT-SIGNATURE extensions: ${JSON.stringify(decoded.extensions?.["payment-identifier"]?.info ?? null)}`);
    }
    if (res.headers.get("payment-response")) {
      const settle = new x402HTTPClient(client).getPaymentSettleResponse((h) => res.headers.get(h));
      console.log(`[client] settle response: ${JSON.stringify(settle)}`);
      if (settle.transaction) {
        const facts = await txFacts(settle.transaction);
        console.log(`[client] tx ${settle.transaction} ${JSON.stringify(facts)}`);
      }
    } else if (res.status === 402) {
      const pr = res.headers.get("payment-required");
      if (pr) console.log(`[client] 402 after payment: ${Buffer.from(pr, "base64").toString()}`);
    }
  } catch (e) {
    console.log(`[client] threw after ${(performance.now() - t0).toFixed(0)} ms (signatures created=${signedCount()}): ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
