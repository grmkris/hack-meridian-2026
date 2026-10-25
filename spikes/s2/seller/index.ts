/**
 * S2 seller: Hono on Bun, one route priced $0.10 on stellar:testnet (x402 v2, @x402/hono 2.28.0).
 *
 *   bun seller/index.ts                    # hosted facilitator https://www.x402.org/facilitator
 *   FACILITATOR=local bun seller/index.ts  # in-process facilitator (facilitator/local.ts)
 *
 * GET /paid/quote declares the payment-identifier extension. Dedup is ours (the middleware does not cache):
 * an outer middleware decodes the PAYMENT-SIGNATURE header, and if the id was already settled for the same
 * fingerprint (scheme, network, asset, amount, payTo, method, path) it replays the cached 200 + PAYMENT-RESPONSE
 * without calling the facilitator; same id with a different fingerprint → 409.
 */
import { Hono } from "hono";
import type { FacilitatorClient } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HOSTED_FACILITATOR, NETWORK, SELLER_PORT, pub } from "../lib/env";
import { localFacilitator } from "../facilitator/local";

const PAY_TO = process.env.STELLAR_PAY_TO ?? pub("PAYTO");
const PRICE = process.env.PRICE ?? "$0.10";
const MODE = process.env.FACILITATOR === "local" ? "local" : "hosted";

function hosted(): FacilitatorClient {
  const inner = new HTTPFacilitatorClient({ url: HOSTED_FACILITATOR });
  const t = async <T>(label: string, p: Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const r = await p;
    console.log(`[facilitator:x402.org] ${label} ${(performance.now() - t0).toFixed(0)} ms ${JSON.stringify(r)}`);
    return r;
  };
  return {
    verify: (p, r) => t("verify", inner.verify(p, r)),
    settle: (p, r) => t("settle", inner.settle(p, r)),
    getSupported: () => t("supported", inner.getSupported()),
  } as FacilitatorClient;
}

export const resourceServer = new x402ResourceServer(MODE === "local" ? localFacilitator() : hosted())
  .register(NETWORK, new ExactStellarScheme())
  .registerExtension(paymentIdentifierResourceServerExtension);

// ---- payment-identifier cache (in memory; the product would use D1/DO) ---------------------------
type Cached = { fingerprint: string; status: number; body: string; headers: Record<string, string> };
const cache = new Map<string, Cached>();
export let settlements = 0;

const fingerprint = (method: string, path: string, a: { scheme: string; network: string; asset: string; amount: string; payTo: string }) =>
  JSON.stringify([a.scheme, a.network, a.asset, a.amount, a.payTo, method, path]);

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, mode: MODE, payTo: PAY_TO, settlements, cached: cache.size }));

app.use("/paid/*", async (c, next) => {
  const header = c.req.header("payment-signature") ?? c.req.header("x-payment");
  if (!header) return next();
  let id: string | null = null;
  let fp = "";
  try {
    const payload = decodePaymentSignatureHeader(header);
    id = extractPaymentIdentifier(payload);
    fp = fingerprint(c.req.method, c.req.path, payload.accepted);
  } catch {
    return next(); // let the x402 middleware produce the proper error
  }
  if (id) {
    const hit = cache.get(id);
    if (hit && hit.fingerprint !== fp) {
      console.log(`[seller] payment-identifier ${id}: fingerprint mismatch → 409`);
      return c.json({ error: "payment_identifier_conflict", id }, 409);
    }
    if (hit) {
      console.log(`[seller] payment-identifier ${id}: cache hit, no verify/settle`);
      return new Response(hit.body, { status: hit.status, headers: { ...hit.headers, "x-s2-cache": "hit" } });
    }
  }
  await next();
  const receipt = c.res.headers.get("payment-response");
  if (c.res.status === 200 && receipt) {
    settlements++;
    if (id) {
      const body = await c.res.clone().text();
      const headers: Record<string, string> = {};
      c.res.headers.forEach((v, k) => (headers[k] = v));
      cache.set(id, { fingerprint: fp, status: 200, body, headers });
      console.log(`[seller] payment-identifier ${id}: cached`);
    }
  }
});

app.use(
  paymentMiddleware(
    {
      "GET /paid/quote": {
        accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
        description: "S2 paid quote",
        mimeType: "application/json",
        extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
      },
    },
    resourceServer,
  ),
);
let served = 0;
app.get("/paid/quote", (c) => c.json({ quote: "Ledgers close every ~5s.", served: ++served, at: new Date().toISOString() }));

console.log(`[seller] ${MODE} facilitator, payTo ${PAY_TO}, ${PRICE} on ${NETWORK}, http://127.0.0.1:${SELLER_PORT}/paid/quote`);
export default { port: SELLER_PORT, fetch: app.fetch };
