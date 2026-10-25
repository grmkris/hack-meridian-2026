/**
 * In-process x402 facilitator for stellar:testnet (FACILITATOR=local), from docs/research/x402-stellar.md Q4.
 * One XLM-funded G key signs and pays every settlement; the fee ceiling is raised to 1,000,000 stroops so a
 * smart-account payer (__check_auth + verifier + policy, ~290–324k stroops measured upstream) fits.
 *
 * Exports `localFacilitator()` (a FacilitatorClient for x402ResourceServer) and `facilitatorScheme`
 * (the raw @x402/stellar facilitator scheme, so callers can verify/settle directly in tests).
 */
import type { FacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as StellarFacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { NETWORK, RPC_URL, secret } from "../lib/env";

export const MAX_FEE_STROOPS = Number(process.env.FACILITATOR_MAX_FEE_STROOPS ?? 1_000_000);

export function facilitatorScheme() {
  return new StellarFacilitatorScheme([createEd25519Signer(secret("FACILITATOR"), NETWORK)], {
    rpcConfig: { url: RPC_URL },
    maxTransactionFeeStroops: MAX_FEE_STROOPS,
  });
}

export function localFacilitator(log = true): FacilitatorClient {
  const f = new x402Facilitator().register(NETWORK, facilitatorScheme());
  const t = async <T>(label: string, p: Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const r = await p;
    if (log) console.log(`[facilitator:local] ${label} ${(performance.now() - t0).toFixed(0)} ms ${JSON.stringify(r)}`);
    return r;
  };
  return {
    verify: (p, r) => t("verify", f.verify(p, r)),
    settle: (p, r) => t("settle", f.settle(p, r)),
    getSupported: async () => f.getSupported(),
  } as FacilitatorClient;
}
