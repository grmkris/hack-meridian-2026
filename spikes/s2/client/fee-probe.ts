/**
 * Probe a hosted facilitator's fee ceiling with /verify only (nothing settles): sign one real payment payload,
 * then re-encode its (unsigned) envelope with larger declared fees. The auth entry signature does not cover the
 * envelope fee, so each variant is otherwise a valid payment. OZ Channels compares the client's tx.fee with its
 * maxTransactionFeeStroops; x402.org derives the fee from its own simulation and ignores the client's.
 *
 *   bun client/fee-probe.ts [hosted|oz]
 */
import { xdr } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { buildClient } from "./pay";
import { USDC_SAC, pub } from "../lib/env";
import { facilitatorClient } from "../lib/facilitators";
import type { FacilitatorName } from "../lib/facilitators";

const which = (process.argv[2] ?? "oz") as FacilitatorName;
const fac = facilitatorClient(which, false);
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "1000000",
  asset: USDC_SAC,
  payTo: pub("PAYTO"),
  maxTimeoutSeconds: 300,
  extra: { areFeesSponsored: true },
};
const { client } = buildClient();
const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: "probe://fee" }, accepts: [requirements] } as never);
const tx0 = (payload.payload as { transaction: string }).transaction;
const env0 = xdr.TransactionEnvelope.fromXDR(tx0, "base64");
console.log(`[fee-probe:${which}] client's declared tx.fee = ${env0.v1().tx().fee()} stroops (resourceFee ${env0.v1().tx().ext().sorobanData().resourceFee().toString()})`);
const fees = process.env.FEES ? process.env.FEES.split(",").map(Number) : [env0.v1().tx().fee(), 50_000, 100_000, 200_000, 400_000, 1_000_000, 10_000_000, 100_000_000];
for (const fee of fees) {
  const env = xdr.TransactionEnvelope.fromXDR(tx0, "base64");
  env.v1().tx().fee(fee);
  const p = { ...payload, payload: { transaction: env.toXDR("base64") } };
  const t0 = performance.now();
  const v = await fac.verify(p, requirements).catch((e: unknown) => ({ thrown: e instanceof Error ? e.message : String(e) }));
  console.log(`[fee-probe:${which}] tx.fee=${String(fee).padStart(9)} → ${(performance.now() - t0).toFixed(0)} ms ${JSON.stringify(v)}`);
}
