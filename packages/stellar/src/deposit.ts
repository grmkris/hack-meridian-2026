import { Account, type Asset, Operation, TimeoutInfinite, TransactionBuilder, type xdr } from '@stellar/stellar-sdk'

import { addr, invokeContractFunc, u32 } from './scval.ts'

/**
 * Deposit addresses (docs/spikes/s8-deposit.md, after Nido's nidohq/nido#165): a sponsored classic `G` per wallet
 * that anyone, an exchange included, can pay USDC to, and that only the deposit router (`contracts/deposit`) can
 * empty, into the one wallet `C` it was bound to.
 *
 * The relayer runs three transactions while G's fresh key exists only in memory:
 *
 * 1. `create`: sponsored `createAccount(G, 0)` and the USDC trustline (the relayer pays both reserves, 1.5 XLM).
 * 2. `register`: the router's `register(G, C, expiration)`, which G authorizes; under it the SAC records
 *    `approve(G, router, i128::MAX, expiration)`. `expiration` = the router's `max_expiration_ledger()` less
 *    `EXPIRATION_MARGIN_LEDGERS`: passed in, because G's signature must not depend on the ledger the call lands in.
 * 3. `lock`: G's master weight to 0, and one pre-authorized-transaction signer for `teardownTx` (remove the
 *    trustline, merge into the relayer), sponsored too. From then on G can authorize nothing but that one
 *    transaction; the key is dropped with the closure. (A teardown signed by G's key before the lock would not do:
 *    signatures are checked against G's signers when the transaction is submitted, and the master key weighs 0 then.)
 *
 * The teardown is a bearer transaction that can only close G (the sponsored reserves, 2 XLM, return to the relayer).
 * Submit it with a fee bump once G is empty and retired. If G still holds USDC it fails and burns G's only sequence
 * number: G stays open (still sweepable by the router), the reserves stay locked.
 */

/** Ops of transaction 1 (relayer source, G signs its own ops). */
export const createDepositOps = (relayer: string, deposit: string, usdc: Asset): ReadonlyArray<xdr.Operation> => [
  Operation.beginSponsoringFutureReserves({ sponsoredId: deposit, source: relayer }),
  Operation.createAccount({ destination: deposit, startingBalance: '0', source: relayer }),
  Operation.changeTrust({ asset: usdc, source: deposit }),
  Operation.endSponsoringFutureReserves({ source: deposit }),
]

/** Transaction 3: master weight 0 and the teardown's pre-auth signer (its reserve sponsored by the relayer). */
export const lockDepositOps = (
  relayer: string,
  deposit: string,
  teardownHash: Uint8Array,
): ReadonlyArray<xdr.Operation> => [
  Operation.beginSponsoringFutureReserves({ sponsoredId: deposit, source: relayer }),
  Operation.setOptions({
    masterWeight: 0,
    signer: { preAuthTx: Buffer.from(teardownHash), weight: 1 },
    source: deposit,
  }),
  Operation.endSponsoringFutureReserves({ source: deposit }),
]

/** Ledgers kept below the network's maximum so the approve still fits when the transaction applies (~8 min). */
export const EXPIRATION_MARGIN_LEDGERS = 100

export const registerFunc = (
  router: string,
  deposit: string,
  recipient: string,
  expirationLedger: number,
): xdr.HostFunction => invokeContractFunc(router, 'register', [addr(deposit), addr(recipient), u32(expirationLedger)])

export const sweepFunc = (router: string, deposit: string): xdr.HostFunction =>
  invokeContractFunc(router, 'sweep', [addr(deposit)])

/**
 * G's teardown, authorized by its pre-auth signer (no signature) and submitted later in a fee bump (G holds no XLM):
 * drop the trustline, merge into the relayer. `sequence` is G's current sequence number (the transaction uses the
 * next one). No time bound.
 */
export const teardownTx = (
  deposit: string,
  sequence: string,
  relayer: string,
  usdc: Asset,
  networkPassphrase: string,
): { readonly xdr: string; readonly hash: Uint8Array } => {
  const tx = new TransactionBuilder(new Account(deposit, sequence), { fee: '200', networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: usdc, limit: '0' }))
    .addOperation(Operation.accountMerge({ destination: relayer }))
    .setTimeout(TimeoutInfinite)
    .build()
  return { xdr: tx.toXDR(), hash: new Uint8Array(tx.hash()) }
}
