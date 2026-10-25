/**
 * The two hosted x402 facilitators S2 uses (no in-process facilitator, by decision 2026-10-25):
 *   hosted → https://www.x402.org/facilitator             (no key)
 *   oz     → https://channels.openzeppelin.com/x402/testnet (Bearer key from /testnet/gen, kept in .env as OZ_CHANNELS_API_KEY)
 * Each client logs per-call latency and the facilitator's JSON response.
 */
import type { FacilitatorClient } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { HOSTED_FACILITATOR, OZ_FACILITATOR, readEnv } from "./env";

export type FacilitatorName = "hosted" | "oz";

export function ozKey(): string {
  const k = process.env.OZ_CHANNELS_API_KEY ?? readEnv().OZ_CHANNELS_API_KEY;
  if (!k) throw new Error("OZ_CHANNELS_API_KEY missing from spikes/s2/.env; run `bun lib/oz-key.ts`");
  return k;
}

export function facilitatorClient(name: FacilitatorName, log = true): FacilitatorClient {
  const inner =
    name === "oz"
      ? new HTTPFacilitatorClient({
          url: OZ_FACILITATOR,
          createAuthHeaders: async () => {
            const h = { Authorization: `Bearer ${ozKey()}` };
            return { verify: h, settle: h, supported: h };
          },
        })
      : new HTTPFacilitatorClient({ url: HOSTED_FACILITATOR });
  const t = async <T>(label: string, p: Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      const r = await p;
      if (log) console.log(`[facilitator:${name}] ${label} ${(performance.now() - t0).toFixed(0)} ms ${JSON.stringify(r).slice(0, 600)}`);
      return r;
    } catch (e) {
      if (log) console.log(`[facilitator:${name}] ${label} THREW after ${(performance.now() - t0).toFixed(0)} ms: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  };
  return {
    verify: (p, r) => t("verify", inner.verify(p, r)),
    settle: (p, r) => t("settle", inner.settle(p, r)),
    getSupported: () => t("supported", inner.getSupported()),
  } as FacilitatorClient;
}

export const facilitatorFromEnv = (): FacilitatorName => (process.env.FACILITATOR === "oz" ? "oz" : "hosted");
