import { DurableObject } from 'cloudflare:workers'
import { Cause, Effect, Exit, Layer } from 'effect'

import { Db, d1Engine } from './db.ts'
import { Ledger, LedgerError, type LedgerShape, makeLocalLedger } from './ledger.ts'

/**
 * One per wallet (`WALLET_OBJECT.getByName(walletId)`): hosts that wallet's Ledger, so every money operation on the
 * wallet (prepare with idempotency, reserve, submit claim, outcome) runs one at a time against D1. The Worker calls it
 * through `ledgerViaObject`; the chain calls happen in the Worker, between a claim and its `settle`.
 */
export type LedgerOp = keyof LedgerShape
export type LedgerReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: LedgerError['reason']; readonly message: string }

interface WalletObjectEnv {
  readonly WALLET_DB: D1Database
}

export class WalletObject extends DurableObject<WalletObjectEnv> {
  private ledger: Promise<LedgerShape> | undefined

  private local(): Promise<LedgerShape> {
    this.ledger ??= Effect.runPromise(makeLocalLedger.pipe(Effect.provide(Db.fromEngine(d1Engine(this.env.WALLET_DB)))))
    return this.ledger
  }

  async call(op: LedgerOp, walletId: string, input: unknown): Promise<LedgerReply> {
    const ledger = await this.local()
    return replyOf(await Effect.runPromiseExit(dispatch(ledger, op, walletId, input)))
  }
}

/** Run one ledger operation by name (the DO side of the RPC, and tests). */
export const dispatch = (ledger: LedgerShape, op: LedgerOp, walletId: string, input: unknown) =>
  // SAFETY: `ledgerViaObject` sends `input` typed as Parameters<LedgerShape[op]>[1]; both sides import LedgerShape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  (ledger[op] as (walletId: string, input: unknown) => Effect.Effect<unknown, LedgerError>)(walletId, input)

export const replyOf = (exit: Exit.Exit<unknown, LedgerError>): LedgerReply =>
  Exit.isSuccess(exit)
    ? { ok: true, value: exit.value }
    : Exit.findErrorOption(exit).pipe(error =>
        error._tag === 'Some'
          ? { ok: false, reason: error.value.reason, message: error.value.message }
          : { ok: false, reason: 'storage', message: Cause.pretty(exit.cause) },
      )

/** The Worker's Ledger: each operation is an RPC to the wallet's Durable Object. */
export const ledgerViaObject = (ns: DurableObjectNamespace<WalletObject>) => {
  const call =
    <K extends LedgerOp>(op: K) =>
    (walletId: string, input: Parameters<LedgerShape[K]>[1]) =>
      Effect.tryPromise({
        try: () => ns.getByName(walletId).call(op, walletId, input),
        catch: cause => new LedgerError({ reason: 'storage', message: `wallet object: ${String(cause)}` }),
      }).pipe(
        Effect.flatMap((reply: LedgerReply) =>
          reply.ok
            ? // SAFETY: the DO returned what LedgerShape[op] succeeds with (structured clone keeps bigint).
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              Effect.succeed(reply.value as Effect.Success<ReturnType<LedgerShape[K]>>)
            : Effect.fail(new LedgerError({ reason: reply.reason, message: reply.message })),
        ),
      )
  return Layer.succeed(Ledger, {
    prepareIntent: call('prepareIntent'),
    claimAutonomous: call('claimAutonomous'),
    claimOwner: call('claimOwner'),
    settle: call('settle'),
    setApprovalPrepared: call('setApprovalPrepared'),
    revokeConnection: call('revokeConnection'),
    recordRuleRemoved: call('recordRuleRemoved'),
    recordSweep: call('recordSweep'),
  })
}
