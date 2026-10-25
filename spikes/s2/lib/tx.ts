/** Read what a settlement cost and who paid it (Horizon), for the fee-per-payment record. */
import { HORIZON_URL, explorerTx } from "./env";

export type TxFacts = { hash: string; ledger: number; feeCharged: number; maxFee: number; source: string; feeAccount: string; successful: boolean; link: string };

export async function txFacts(hash: string, tries = 10): Promise<TxFacts | undefined> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${HORIZON_URL}/transactions/${hash}`);
    if (r.ok) {
      const t = (await r.json()) as Record<string, unknown>;
      return {
        hash,
        ledger: t.ledger as number,
        feeCharged: Number(t.fee_charged),
        maxFee: Number(t.max_fee),
        source: t.source_account as string,
        feeAccount: (t.fee_account as string) ?? (t.source_account as string),
        successful: t.successful as boolean,
        link: explorerTx(hash),
      };
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return undefined;
}
