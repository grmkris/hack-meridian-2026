import { Duration, Effect, Schedule } from 'effect'

import { ChainError } from '@hm/protocol'
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'

import { INCLUSION_FEE } from './constants.ts'
import { fromOnchainFailure, fromSimulationError, messageOf, rpcError } from './errors.ts'
import { explorerTx, type NetworkParams } from './network.ts'

/**
 * Soroban RPC as Effects (`fetch` underneath, via the SDK's default entry, so it runs in workerd). Reads retry twice;
 * `sendTransaction` never retries on its own.
 */
export interface TxOutcome {
  readonly hash: string
  readonly ledger: number
  readonly feeCharged: bigint
  /** The account that paid: the tx source, or the fee-bump payer. */
  readonly feeSource: string
  /** Rent part of the charge, from the Soroban meta (absent for classic transactions). */
  readonly rentCharged: bigint | undefined
  readonly returnValue: xdr.ScVal | undefined
  readonly explorer: string
}

export type SimSuccess = rpc.Api.SimulateTransactionSuccessResponse

const READ_TIMEOUT = Duration.seconds(20)
const readRetry = { times: 2, schedule: Schedule.spaced(Duration.millis(400)) }

export interface Soroban {
  readonly server: rpc.Server
  readonly networkPassphrase: string
  readonly read: <A>(label: string, f: (server: rpc.Server) => Promise<A>) => Effect.Effect<A, ChainError>
  readonly latestLedger: Effect.Effect<number, ChainError>
  readonly sequence: (address: string) => Effect.Effect<string, ChainError>
  readonly simulate: (
    tx: Transaction,
    authMode: rpc.Api.SimulationAuthMode | undefined,
    stage: string,
  ) => Effect.Effect<SimSuccess, ChainError>
  readonly sendAndPoll: (tx: Transaction) => Effect.Effect<TxOutcome, ChainError>
  readonly getTransaction: (hash: string) => Effect.Effect<TxOutcome, ChainError>
  readonly view: (source: string, contract: xdr.HostFunction) => Effect.Effect<xdr.ScVal, ChainError>
  readonly buildInvoke: (
    source: string,
    seq: string,
    func: xdr.HostFunction,
    auth: ReadonlyArray<xdr.SorobanAuthorizationEntry>,
  ) => Transaction
}

const attempt = <A>(label: string, s: rpc.Server, f: (s: rpc.Server) => Promise<A>) =>
  Effect.tryPromise({ try: () => f(s), catch: e => rpcError(label, e) }).pipe(
    Effect.timeoutOrElse({ duration: READ_TIMEOUT, orElse: () => Effect.fail(rpcError(label, 'timed out')) }),
    Effect.retry(readRetry),
  )

const serverFor = (url: string) => new rpc.Server(url, { allowHttp: url.startsWith('http://') })

export const makeSoroban = (network: NetworkParams): Soroban => {
  const networkPassphrase = network.passphrase
  const server = serverFor(network.rpcUrl)
  const fallback = network.rpcFallbackUrl === null ? undefined : serverFor(network.rpcFallbackUrl)

  /** A read on the primary RPC, then on the fallback when the primary does not answer. */
  const read = <A>(label: string, f: (s: rpc.Server) => Promise<A>): Effect.Effect<A, ChainError> =>
    fallback === undefined
      ? attempt(label, server, f)
      : attempt(label, server, f).pipe(Effect.catch(() => attempt(`${label} (fallback RPC)`, fallback, f)))

  const latestLedger = read('getLatestLedger', s => s.getLatestLedger()).pipe(Effect.map(r => r.sequence))
  const sequence = (address: string) =>
    read(`getAccount ${address}`, s => s.getAccount(address)).pipe(Effect.map(a => a.sequenceNumber()))

  const buildInvoke = (
    source: string,
    seq: string,
    func: xdr.HostFunction,
    auth: ReadonlyArray<xdr.SorobanAuthorizationEntry>,
  ): Transaction =>
    new TransactionBuilder(new Account(source, seq), { fee: String(INCLUSION_FEE), networkPassphrase })
      .addOperation(Operation.invokeHostFunction({ func, auth: [...auth] }))
      .setTimeout(120)
      .build()

  /** `authMode` only for InvokeHostFunction; the SDK refuses it for ExtendFootprintTTL and RestoreFootprint. */
  const simulate = (tx: Transaction, authMode: rpc.Api.SimulationAuthMode | undefined, stage: string) =>
    read(`simulate (${authMode ?? 'default'})`, s => s.simulateTransaction(tx, undefined, authMode)).pipe(
      Effect.flatMap(sim =>
        rpc.Api.isSimulationSuccess(sim)
          ? Effect.succeed(sim)
          : Effect.fail(fromSimulationError(rpc.Api.isSimulationError(sim) ? sim.error : 'simulation failed', stage)),
      ),
    )

  const outcome = (hash: string, r: rpc.Api.GetSuccessfulTransactionResponse): TxOutcome => {
    const env = TransactionBuilder.fromXDR(r.envelopeXdr, networkPassphrase)
    return {
      hash,
      ledger: r.ledger,
      feeCharged: BigInt(r.resultXdr.feeCharged().toString()),
      feeSource: env instanceof FeeBumpTransaction ? env.feeSource : env.source,
      rentCharged: rentOf(r.resultMetaXdr),
      returnValue: r.returnValue,
      explorer: explorerTx(network, hash),
    }
  }

  const poll = (hash: string) =>
    read(`getTransaction ${hash}`, s => s.getTransaction(hash)).pipe(
      Effect.flatMap(r =>
        r.status === rpc.Api.GetTransactionStatus.NOT_FOUND ? Effect.fail('pending' as const) : Effect.succeed(r),
      ),
      Effect.retry({
        schedule: Schedule.spaced(Duration.seconds(1)),
        times: 60,
        while: e => e === 'pending',
      }),
      Effect.mapError(e =>
        e === 'pending' ? new ChainError({ kind: 'unknown', message: 'not final after 60 s', tx: hash }) : e,
      ),
      Effect.flatMap(r =>
        r.status === rpc.Api.GetTransactionStatus.SUCCESS
          ? Effect.succeed(outcome(hash, r))
          : Effect.fail(
              r.status === rpc.Api.GetTransactionStatus.FAILED
                ? fromOnchainFailure(hash, r.resultXdr.result().switch().name, r.diagnosticEventsXdr ?? [])
                : new ChainError({ kind: 'unknown', message: 'transaction not found', tx: hash }),
            ),
      ),
    )

  const sendAndPoll = (tx: Transaction) =>
    Effect.gen(function* () {
      const hash = tx.hash().toString('hex')
      const sent = yield* Effect.tryPromise({
        try: () =>
          server
            .sendTransaction(tx)
            .catch(e => (fallback === undefined ? Promise.reject(e) : fallback.sendTransaction(tx))),
        catch: e => new ChainError({ kind: 'unknown', message: `sendTransaction: ${messageOf(e)}`, tx: hash }),
      })
      if (sent.status === 'ERROR') {
        const code = sent.errorResult?.result().switch().name ?? 'ERROR'
        return yield* new ChainError({ kind: 'submit_failed', message: `rejected before apply: ${code}`, tx: hash })
      }
      return yield* poll(hash)
    })

  const view = (source: string, func: xdr.HostFunction) =>
    Effect.gen(function* () {
      const seq = yield* sequence(source)
      const sim = yield* simulate(buildInvoke(source, seq, func, []), 'record', 'view')
      return sim.result?.retval ?? xdr.ScVal.scvVoid()
    })

  return {
    server,
    networkPassphrase,
    read,
    latestLedger,
    sequence,
    simulate,
    sendAndPoll,
    getTransaction: hash => poll(hash),
    view,
    buildInvoke,
  }
}

/** Rent charged, from TransactionMeta v3/v4 Soroban meta ext v1. */
export const rentOf = (meta: xdr.TransactionMeta): bigint | undefined => {
  try {
    const sm = meta.switch() === 4 ? meta.v4().sorobanMeta() : meta.switch() === 3 ? meta.v3().sorobanMeta() : null
    const ext = sm?.ext()
    if (!ext || ext.switch() !== 1) return undefined
    return BigInt(ext.v1().rentFeeCharged().toString())
  } catch {
    return undefined
  }
}

/** `rejected before apply: txBadSeq` and friends: safe to retry on another relayer (nothing was applied). */
export const isRetryableRejection = (e: ChainError): boolean =>
  e.kind === 'submit_failed' &&
  /rejected before apply: (txBadSeq|txInsufficientBalance|txInsufficientFee)/u.test(e.message)

/** Sign the envelope with `signers` (the relayer first) and return it. */
export const signWith = (tx: Transaction, ...signers: ReadonlyArray<Keypair>): Transaction => {
  tx.sign(...signers)
  return tx
}

export const nativeOf = (v: xdr.ScVal): unknown => scValToNative(v)
