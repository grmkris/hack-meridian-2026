import { Effect } from 'effect'

import { ChainError } from '@hm/protocol'
import { Account, Keypair, Operation, rpc, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk'

import { INCLUSION_FEE } from './constants.ts'
import type { RelayerPool } from './relayers.ts'
import { signWith, type Soroban, type TxOutcome } from './soroban.ts'

/**
 * The proven smart-account flow (spike S1): simulate (record) → authorize the entries → simulate again in enforce mode
 * with the signed entries (runs `__check_auth`, verifiers and policies; refusals surface here, never onchain) →
 * assemble from the ENFORCE simulation → a relayer signs → send → poll. The relayer sequence is read at submit time,
 * so prepare and finalize can be minutes apart and use different relayers (auth entries do not bind the envelope).
 */
export interface PreparedCall {
  readonly func: xdr.HostFunction
  /** Unsigned entries from the record simulation, one per authorizer. */
  readonly entries: ReadonlyArray<xdr.SorobanAuthorizationEntry>
  readonly latestLedger: number
}

export interface Invoker {
  readonly soroban: Soroban
  readonly pool: RelayerPool
  readonly prepare: (
    func: xdr.HostFunction,
    authMode?: 'record' | 'record_allow_nonroot',
  ) => Effect.Effect<PreparedCall, ChainError>
  readonly submit: (
    func: xdr.HostFunction,
    signedEntries: ReadonlyArray<xdr.SorobanAuthorizationEntry>,
    maxFeeStroops?: bigint,
  ) => Effect.Effect<TxOutcome, ChainError>
  /** `ExtendFootprintTTL` over `readOnly` keys to `extendTo` ledgers from now; the relayer pays the rent. */
  readonly extendTtl: (
    readOnly: ReadonlyArray<xdr.LedgerKey>,
    extendTo: number,
    maxFeeStroops?: bigint,
  ) => Effect.Effect<TxOutcome, ChainError>
  /** A Soroban call whose only auth is the relayer itself as source (deploy). Assembles from the record simulation. */
  readonly submitSourceAuthorized: (
    build: (relayer: Keypair) => xdr.Operation,
  ) => Effect.Effect<{ outcome: TxOutcome; sim: rpc.Api.SimulateTransactionSuccessResponse }, ChainError>
  /** A classic transaction, relayer as source; `extraSigners` sign for operations sourced at their accounts. */
  readonly submitClassic: (
    ops: (relayer: Keypair) => ReadonlyArray<xdr.Operation>,
    extraSigners: ReadonlyArray<Keypair>,
  ) => Effect.Effect<TxOutcome, ChainError>
}

export const makeInvoker = (soroban: Soroban, pool: RelayerPool, maxFeeStroops: bigint): Invoker => {
  const checkFee = (tx: { fee: string }, ceiling: bigint = maxFeeStroops) =>
    BigInt(tx.fee) > ceiling
      ? Effect.fail(
          new ChainError({
            kind: 'submit_failed',
            message: `fee_ceiling_exceeded: the enforce simulation needs ${tx.fee} stroops, the ceiling is ${ceiling}; not submitted`,
          }),
        )
      : Effect.void

  const prepare = (func: xdr.HostFunction, authMode: 'record' | 'record_allow_nonroot' = 'record') =>
    Effect.gen(function* () {
      const source = pool.primary.publicKey()
      const seq = yield* soroban.sequence(source)
      const sim = yield* soroban.simulate(soroban.buildInvoke(source, seq, func, []), authMode, 'simulation')
      return { func, entries: sim.result?.auth ?? [], latestLedger: sim.latestLedger } satisfies PreparedCall
    })

  const submit = (
    func: xdr.HostFunction,
    signedEntries: ReadonlyArray<xdr.SorobanAuthorizationEntry>,
    ceiling?: bigint,
  ) =>
    pool.run(relayer =>
      Effect.gen(function* () {
        const source = relayer.publicKey()
        const seq = yield* soroban.sequence(source)
        const signed = soroban.buildInvoke(source, seq, func, signedEntries)
        const sim = yield* soroban.simulate(signed, 'enforce', 'enforce simulation')
        const tx = rpc.assembleTransaction(signed, sim).build()
        yield* checkFee(tx, ceiling)
        return yield* soroban.sendAndPoll(signWith(tx, relayer))
      }),
    )

  const submitSourceAuthorized = (build: (relayer: Keypair) => xdr.Operation) =>
    pool.run(relayer =>
      Effect.gen(function* () {
        const source = relayer.publicKey()
        const seq = yield* soroban.sequence(source)
        const raw = new TransactionBuilder(new Account(source, seq), {
          fee: String(INCLUSION_FEE),
          networkPassphrase: soroban.networkPassphrase,
        })
          .addOperation(build(relayer))
          .setTimeout(120)
          .build()
        const sim = yield* soroban.simulate(raw, 'record', 'simulation')
        const tx = rpc.assembleTransaction(raw, sim).build()
        yield* checkFee(tx)
        const outcome = yield* soroban.sendAndPoll(signWith(tx, relayer))
        return { outcome, sim }
      }),
    )

  const submitClassic = (
    ops: (relayer: Keypair) => ReadonlyArray<xdr.Operation>,
    extraSigners: ReadonlyArray<Keypair>,
  ) =>
    pool.run(relayer =>
      Effect.gen(function* () {
        const source = relayer.publicKey()
        const seq = yield* soroban.sequence(source)
        const builder = new TransactionBuilder(new Account(source, seq), {
          fee: String(INCLUSION_FEE),
          networkPassphrase: soroban.networkPassphrase,
        })
        for (const op of ops(relayer)) builder.addOperation(op)
        const tx = builder.setTimeout(120).build()
        return yield* soroban.sendAndPoll(signWith(tx, relayer, ...extraSigners))
      }),
    )

  const extendTtl = (readOnly: ReadonlyArray<xdr.LedgerKey>, extendTo: number, ceiling?: bigint) =>
    pool.run(relayer =>
      Effect.gen(function* () {
        const source = relayer.publicKey()
        const seq = yield* soroban.sequence(source)
        const raw = new TransactionBuilder(new Account(source, seq), {
          fee: String(INCLUSION_FEE),
          networkPassphrase: soroban.networkPassphrase,
        })
          .addOperation(Operation.extendFootprintTtl({ extendTo }))
          .setSorobanData(new SorobanDataBuilder().setReadOnly([...readOnly]).build())
          .setTimeout(120)
          .build()
        const sim = yield* soroban.simulate(raw, 'record', 'extend simulation')
        const tx = rpc.assembleTransaction(raw, sim).build()
        yield* checkFee(tx, ceiling)
        return yield* soroban.sendAndPoll(signWith(tx, relayer))
      }),
    )

  return { soroban, pool, prepare, submit, submitSourceAuthorized, submitClassic, extendTtl }
}
