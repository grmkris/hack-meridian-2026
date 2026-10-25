import { DurableObject } from 'cloudflare:workers'
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Redacted } from 'effect'

import { explorerTx, makeSoroban, networkConfig, transfersTo } from '@hm/stellar'

import { Db, d1Engine } from './db.ts'
import { driveWallet, type DriverResult, EventsWake, type WatchSource } from './events/driver.ts'
import { journalMaxSeq, walletsWithEventsAfter } from './events/store.ts'
import { Ledger, LedgerError, type LedgerShape, makeLocalLedger } from './ledger.ts'
import { stringBindings } from './wallet-settings.ts'

/**
 * One per wallet (`WALLET_OBJECT.getByName(walletId)`): hosts that wallet's Ledger, so every money operation on the
 * wallet (prepare with idempotency, reserve, submit claim, outcome) runs one at a time against D1. The Worker calls it
 * through `ledgerViaObject`; the chain calls happen in the Worker, between a claim and its `settle`.
 */
export type LedgerOp = keyof LedgerShape
export type LedgerReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: LedgerError['reason']; readonly message: string }

/**
 * The bindings the object reads (all of the Worker's reach it at runtime; apps/web/alchemy.run.ts): the database,
 * the namespace to wake other wallets' objects, and the settings and vault key the events driver needs.
 */
export interface WalletObjectEnv {
  readonly WALLET_DB: D1Database
  readonly WALLET_OBJECT: DurableObjectNamespace<WalletObject>
  readonly CHAIN?: string
  readonly STAGE?: string
  readonly VAULT_KEY?: string
}

/** Ledger operations that can journal events (events/emit.ts); `settle` can journal another wallet's too. */
const JOURNALING: ReadonlySet<LedgerOp> = new Set<LedgerOp>([
  'prepareIntent',
  'claimAutonomous',
  'settle',
  'revokeConnection',
])

export class WalletObject extends DurableObject<WalletObjectEnv> {
  private ledger: Promise<LedgerShape> | undefined
  private watchSource: Promise<WatchSource | undefined> | undefined
  private readonly wake = new EventsWake(
    {
      getAlarm: () => this.ctx.storage.getAlarm(),
      setAlarm: at => this.ctx.storage.setAlarm(at),
      get: key => this.ctx.storage.get(key),
      put: (key, value) => this.ctx.storage.put(key, value),
    },
    () => Date.now(),
  )

  private db() {
    return Db.fromEngine(d1Engine(this.env.WALLET_DB))
  }

  private local(): Promise<LedgerShape> {
    this.ledger ??= Effect.runPromise(makeLocalLedger.pipe(Effect.provide(this.db())))
    return this.ledger
  }

  async call(op: LedgerOp, walletId: string, input: unknown): Promise<LedgerReply> {
    const ledger = await this.local()
    const before = op === 'settle' ? await this.journalHead() : undefined
    const reply = replyOf(await Effect.runPromiseExit(dispatch(ledger, op, walletId, input)))
    if (JOURNALING.has(op)) await this.afterJournal(walletId, before)
    return reply
  }

  /** Something was journaled for this wallet elsewhere (the Worker, another wallet's object): deliver it now. */
  async poke(walletId: string): Promise<void> {
    await this.wake.poke(walletId)
  }

  override async alarm(): Promise<void> {
    await this.wake.run(input => this.drive(input))
  }

  private async journalHead(): Promise<number | undefined> {
    const exit = await Effect.runPromiseExit(journalMaxSeq.pipe(Effect.provide(this.db())))
    return Exit.isSuccess(exit) ? exit.value : undefined
  }

  /** Arm this wallet's alarm; after a settle, wake every other wallet it journaled for (a Nod→Nod payment). */
  private async afterJournal(walletId: string, before: number | undefined): Promise<void> {
    try {
      await this.wake.poke(walletId)
      if (before === undefined) return
      const exit = await Effect.runPromiseExit(walletsWithEventsAfter(before).pipe(Effect.provide(this.db())))
      if (!Exit.isSuccess(exit)) return
      await Promise.all(
        exit.value
          .filter(other => other !== walletId)
          .map(other =>
            this.env.WALLET_OBJECT.getByName(other)
              .poke(other)
              .catch(() => undefined),
          ),
      )
    } catch {
      // Events never fail a ledger operation: the next alarm or poke delivers what is journaled.
    }
  }

  private drive(input: { walletId: string; watchCursor: string | null; pruneDue: boolean }): Promise<DriverResult> {
    const env = this.env
    const vault = env.VAULT_KEY
    return this.watcher().then(watch =>
      Effect.runPromise(
        driveWallet({
          walletId: input.walletId,
          vaultKey: vault === undefined || vault === '' ? Option.none() : Option.some(Redacted.make(vault)),
          local: env.STAGE === 'local',
          watch,
          watchCursor: input.watchCursor,
          pruneDue: input.pruneDue,
        }).pipe(Effect.provide(this.db())),
      ),
    )
  }

  /** On the real chain: USDC transfers to the wallet from Soroban RPC (no relayer, no secrets). */
  private watcher(): Promise<WatchSource | undefined> {
    const env = this.env
    if (env.CHAIN !== 'testnet' && env.CHAIN !== 'stellar') return Promise.resolve(undefined)
    this.watchSource ??= Effect.runPromise(
      networkConfig.pipe(
        Effect.map((network): WatchSource => {
          const soroban = makeSoroban(network)
          const sac = network.contracts.usdcSac
          return {
            transfers: (to, cursor) =>
              cursor === null
                ? Effect.flatMap(soroban.latestLedger, latest =>
                    transfersTo(soroban, { sac, to, from: { startLedger: latest } }),
                  )
                : transfersTo(soroban, { sac, to, from: { cursor } }).pipe(
                    // A cursor older than the RPC's retention: start again from now.
                    Effect.catch(() =>
                      Effect.flatMap(soroban.latestLedger, latest =>
                        transfersTo(soroban, { sac, to, from: { startLedger: latest } }),
                      ),
                    ),
                  ),
            explorerTx: hash => explorerTx(network, hash),
          }
        }),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(stringBindings(env)))),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return this.watchSource
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
    claimFunded: call('claimFunded'),
    setClaimPrepared: call('setClaimPrepared'),
    approveClaim: call('approveClaim'),
    claimApproved: call('claimApproved'),
    revokeConnection: call('revokeConnection'),
    recordRuleRemoved: call('recordRuleRemoved'),
    recordSweep: call('recordSweep'),
  })
}
