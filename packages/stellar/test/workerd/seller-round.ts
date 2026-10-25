import { Effect } from 'effect'

import { Chain, type Receipt } from '@hm/protocol'
import { Keypair } from '@stellar/stellar-sdk'

import { StellarOps } from '../../src/index.ts'

const row = (r: Receipt | null) =>
  r === null ? null : { tx: r.tx, ledger: r.ledger, feeStroops: r.feeStroops.toString(), feePayer: r.feePayer }

/**
 * One paid HTTP call and one paid MCP call against the demo seller (apps/seller), from a fresh pocket that the
 * treasury tops up directly (no grant needed for this check), then sweep and close. Runs in Bun (live test) and in
 * workerd (test/workerd/worker.ts), so the same code proves the x402 path in both runtimes.
 */
export const sellerRound = (sellerUrl: string, treasuryAddress: string, tag: string) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    const ops = yield* StellarOps
    const signer = yield* chain.newSigner
    const pocket = yield* chain.createPocket(signer.signerKeyRef)
    const funded = yield* chain.fundNewWallet(pocket.address, 2_500_000n)
    const http = yield* chain.payX402(
      signer.signerKeyRef,
      `${sellerUrl}/api/market-brief`,
      1_000_000n,
      `a2_${tag}_http_${Date.now()}`,
      () => Effect.void,
    )
    const httpBody = yield* Effect.promise(() => http.body.text())
    const mcp = yield* chain.payX402Mcp(
      signer.signerKeyRef,
      `${sellerUrl}/mcp`,
      'market_brief',
      { topic: 'XLM/USDC' },
      1_000_000n,
      `a2_${tag}_mcp_${Date.now()}`,
      () => Effect.void,
    )
    const swept = yield* chain.sweepPocket(signer.signerKeyRef, treasuryAddress)
    const closed = yield* ops.closePocket(signer.signerKeyRef)
    return {
      pocket: pocket.address,
      createPocket: pocket.tx,
      fundPocket: funded.tx,
      http: {
        status: http.body.status,
        bytes: httpBody.length,
        quote: http.quote?.amountStroops.toString(),
        settlement: row(http.settlement),
      },
      mcp: {
        quote: mcp.quote?.amountStroops.toString(),
        settlement: row(mcp.settlement),
        result: JSON.stringify(mcp.result).slice(0, 160),
      },
      sweep: row(swept),
      close: row(closed),
    }
  })

export const treasuryAddressOf = (secret: string): string => Keypair.fromSecret(secret).publicKey()
