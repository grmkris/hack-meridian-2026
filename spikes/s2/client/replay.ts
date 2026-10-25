/**
 * Replay a consumed x402 Stellar payment payload straight at a facilitator (no seller cache in the way),
 * to show the auth-entry nonce makes a second settlement impossible.
 *
 *   bun client/replay.ts <file with base64 PAYMENT-SIGNATURE> [hosted|local] [--settle]
 */
import { readFileSync } from "node:fs";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { HOSTED_FACILITATOR } from "../lib/env";

const [file, mode = "hosted"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const payload = decodePaymentSignatureHeader(readFileSync(file!, "utf8").trim());
const requirements = payload.accepted;
const fac =
  mode === "local"
    ? (await import("../facilitator/local")).localFacilitator(false)
    : new HTTPFacilitatorClient({ url: HOSTED_FACILITATOR });
let t0 = performance.now();
const v = await fac.verify(payload, requirements).catch((e: unknown) => ({ thrown: String(e) }));
console.log(`[replay:${mode}] verify ${(performance.now() - t0).toFixed(0)} ms → ${JSON.stringify(v)}`);
if (process.argv.includes("--settle")) {
  t0 = performance.now();
  const s = await fac.settle(payload, requirements).catch((e: unknown) => ({ thrown: String(e) }));
  console.log(`[replay:${mode}] settle ${(performance.now() - t0).toFixed(0)} ms → ${JSON.stringify(s)}`);
}
