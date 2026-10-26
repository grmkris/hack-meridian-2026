import { DateTime, Duration, Effect, Schema } from 'effect'

import type { DepositAddressView } from '@hm/api'
import { Chain, type ChainError, type Wallet } from '@hm/protocol'

import { randomId } from './clock.ts'
import { DbError } from './db.ts'
import { EventsHost } from './events/host.ts'
import { Network } from './network.ts'
import { logFailure } from './observe/log.ts'
import { first, sql, write } from './rows.ts'
import { walletById } from './store.ts'
import { b64urlDecode } from './webauthn.ts'

/**
 * Deposit addresses (docs/spikes/s8-deposit.md, after nidohq/nido#165): one sponsored classic `G…` per wallet that
 * anyone, an exchange included, can pay USDC to. The deposit router binds it to the wallet's `C…` for good, so a
 * sweep, by anyone, can only move it there. Created on first request; swept by `POST /api/wallet/sweep` and by the
 * wallet's Durable Object every 60 s for a day after the address was last shown (`depositWatchTick`).
 */

/** A `creating` claim older than this belongs to a request that died; the next request builds a new G. */
export const CLAIM_STALE = Duration.minutes(2)
/** How long the Durable Object keeps sweeping after the address was shown, and how often. */
export const WATCH_FOR = Duration.hours(24)
export const WATCH_EVERY = Duration.seconds(60)
const LEDGER_MS = 5_000

export class DepositError extends Schema.TaggedError<DepositError>()('DepositError', {
  /** unavailable: no router on this network; busy: another request is building it; chain: the chain refused. */
  reason: Schema.Literals(['unavailable', 'busy', 'chain']),
  message: Schema.String,
}) {}

const DepositRow = Schema.Struct({
  wallet_id: Schema.String,
  status: Schema.Literals(['creating', 'active', 'failed']),
  claim_token: Schema.String,
  claimed_at: Schema.String,
  recipient: Schema.String,
  address: Schema.NullOr(Schema.String),
  expiration_ledger: Schema.NullOr(Schema.Finite),
  expires_at: Schema.NullOr(Schema.String),
  create_tx: Schema.NullOr(Schema.String),
  register_tx: Schema.NullOr(Schema.String),
  lock_tx: Schema.NullOr(Schema.String),
  swept_total: Schema.String,
  last_sweep_tx: Schema.NullOr(Schema.String),
  last_sweep_at: Schema.NullOr(Schema.String),
  watch_until: Schema.NullOr(Schema.String),
})
export type DepositRow = typeof DepositRow.Type

/** A row whose G is registered and locked. */
export interface ActiveDeposit extends DepositRow {
  readonly status: 'active'
  readonly address: string
}

const toRow = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(DepositRow)(row).pipe(
    Effect.mapError(error => new DbError({ operation: 'decode deposit_addresses', message: String(error) })),
  )

const isActive = (row: DepositRow | undefined): row is ActiveDeposit =>
  row !== undefined && row.status === 'active' && row.address !== null

const COLUMNS = `wallet_id, status, claim_token, claimed_at, recipient, address, expiration_ledger, expires_at, create_tx,
  register_tx, lock_tx, swept_total, last_sweep_tx, last_sweep_at, watch_until`

export const depositOfWallet = (walletId: string) =>
  first(sql(`SELECT ${COLUMNS} FROM deposit_addresses WHERE wallet_id = ?`, walletId), toRow)

/** The `G…` of the wallet's deposit address, when it exists. */
export const depositAddressOf = (walletId: string) =>
  Effect.map(depositOfWallet(walletId), row => (isActive(row) ? row.address : null))

const iso = (time: DateTime.Utc) => DateTime.formatIso(time)

const fromChain = (error: ChainError) =>
  new DepositError({
    reason: error.message.startsWith('deposit_unavailable') ? 'unavailable' : 'chain',
    message: error.message,
  })

/**
 * The wallet's deposit address, created on the first call: claim the row (one builder per wallet; a stale or failed
 * claim is taken over), build G on the chain (~15 s, three transactions), store it. A second request meanwhile fails
 * `busy`.
 */
export const ensureDepositAddress = (wallet: Wallet) =>
  Effect.gen(function* () {
    const existing = yield* depositOfWallet(wallet.id)
    if (isActive(existing)) return existing
    const now = yield* DateTime.now
    const token = yield* randomId('dcl')
    const staleBefore = iso(DateTime.subtractDuration(now, CLAIM_STALE))
    yield* write(
      sql(
        `INSERT INTO deposit_addresses (wallet_id, status, claim_token, claimed_at, recipient) VALUES (?, 'creating', ?, ?, ?)
         ON CONFLICT (wallet_id) DO UPDATE SET status = 'creating', claim_token = excluded.claim_token,
           claimed_at = excluded.claimed_at, recipient = excluded.recipient
         WHERE deposit_addresses.status = 'failed'
            OR (deposit_addresses.status = 'creating' AND deposit_addresses.claimed_at < ?)`,
        wallet.id,
        token,
        iso(now),
        wallet.contract_id,
        staleBefore,
      ),
    )
    const claimed = yield* depositOfWallet(wallet.id)
    if (isActive(claimed)) return claimed
    if (claimed?.claim_token !== token)
      return yield* new DepositError({ reason: 'busy', message: 'deposit_address_creating: retry in a few seconds' })
    const created = yield* Chain.use(chain => chain.createDepositAddress(wallet.contract_id)).pipe(
      Effect.tapError(() =>
        write(
          sql(
            `UPDATE deposit_addresses SET status = 'failed' WHERE wallet_id = ? AND claim_token = ?`,
            wallet.id,
            token,
          ),
        ).pipe(Effect.ignore),
      ),
      Effect.mapError(fromChain),
    )
    const done = yield* DateTime.now
    const expiresAt = DateTime.add(done, {
      milliseconds: (created.expirationLedger - created.registeredLedger) * LEDGER_MS,
    })
    yield* write(
      sql(
        `UPDATE deposit_addresses SET status = 'active', address = ?, expiration_ledger = ?, expires_at = ?,
           create_tx = ?, register_tx = ?, lock_tx = ?, teardown_xdr = ?, created_at = ?
         WHERE wallet_id = ? AND claim_token = ?`,
        created.address,
        created.expirationLedger,
        iso(expiresAt),
        created.txs.create,
        created.txs.register,
        created.txs.lock,
        created.teardownXdr,
        iso(done),
        wallet.id,
        token,
      ),
    )
    const row = yield* depositOfWallet(wallet.id)
    if (!isActive(row)) return yield* new DbError({ operation: 'deposit_addresses', message: 'row not active' })
    return row
  })

/** USDC waiting on G (stroops); null when the chain did not answer. */
export const pendingOf = (row: ActiveDeposit) =>
  Chain.use(chain => chain.balances(row.address)).pipe(
    Effect.map(b => b.usdc),
    Effect.orElseSucceed(() => null),
  )

export const depositView = (row: ActiveDeposit, pending: bigint | null): DepositAddressView => ({
  address: row.address,
  recipient: row.recipient,
  expires_ledger: row.expiration_ledger ?? 0,
  expires_at: row.expires_at ?? '',
  pending: pending === null ? null : pending.toString(),
  swept_total: row.swept_total,
  create_tx: row.create_tx ?? '',
  register_tx: row.register_tx ?? '',
  lock_tx: row.lock_tx ?? '',
  last_sweep_tx: row.last_sweep_tx,
})

/** Keep the wallet's Durable Object sweeping for `WATCH_FOR` from now, and wake it. */
export const watchDeposit = (walletId: string) =>
  Effect.gen(function* () {
    const until = DateTime.addDuration(yield* DateTime.now, WATCH_FOR)
    yield* write(sql('UPDATE deposit_addresses SET watch_until = ? WHERE wallet_id = ?', iso(until), walletId))
    yield* EventsHost.use(host => host.poke(walletId))
  })

/** The permissionless sweep into the wallet; records what moved. `swept` 0n and `tx` null when G was empty. */
export const sweepDeposit = (row: ActiveDeposit) =>
  Effect.gen(function* () {
    const result = yield* Chain.use(chain => chain.sweepDeposit(row.address, row.recipient)).pipe(
      Effect.mapError(fromChain),
    )
    if (result === null) return { swept: 0n, tx: null, row }
    yield* write(
      sql(
        `UPDATE deposit_addresses SET swept_total = CAST(CAST(swept_total AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
           last_sweep_tx = ?, last_sweep_at = ? WHERE wallet_id = ?`,
        result.amountStroops.toString(),
        result.receipt.tx,
        iso(yield* DateTime.now),
        row.wallet_id,
      ),
    )
    const updated = yield* depositOfWallet(row.wallet_id)
    return { swept: result.amountStroops, tx: result.receipt.tx, row: isActive(updated) ? updated : row }
  })

/**
 * One alarm turn of the wallet's Durable Object: sweep while the watch lasts, and deploy a deposit-first wallet once
 * USDC is there. `nextAt` (epoch ms) is when to look again, null when the watch is over or there is no address. An
 * idle address costs one ledger read.
 */
export const depositWatchTick = (walletId: string) =>
  Effect.gen(function* () {
    const row = yield* depositOfWallet(walletId)
    const now = yield* DateTime.now
    if (!isActive(row) || row.watch_until === null) return { nextAt: null, swept: 0n }
    const until = DateTime.makeUnsafe(row.watch_until)
    if (DateTime.isLessThanOrEqualTo(until, now)) return { nextAt: null, swept: 0n }
    const { swept } = yield* sweepDeposit(row)
    yield* activateIfFunded(walletId, swept).pipe(
      Effect.catch(error => logFailure('warn', 'activation.deposit_first_failed', error, { wallet_id: walletId })),
    )
    return { nextAt: DateTime.toEpochMillis(DateTime.addDuration(now, WATCH_EVERY)), swept }
  })

// Deposit-first signup (K2): the passkey and the deposit address at once; the smart account deploys when USDC arrives.

/** Whether wallet creation plans the account instead of deploying it. */
export const depositFirstSignup = (requested: boolean | undefined) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    if (!chain.depositsAvailable) return false
    // Testnet keeps the judge path (deploy now, 10 welcome USDC) unless the caller asks; pubnet is deposit-first.
    return requested === true || !(yield* Network).welcomeFunding
  })

const ActivationRow = Schema.Struct({
  wallet_id: Schema.String,
  status: Schema.Literals(['awaiting_deposit', 'deploying', 'active', 'failed']),
  deployer: Schema.String,
  salt: Schema.String,
  claim_token: Schema.NullOr(Schema.String),
  claimed_at: Schema.NullOr(Schema.String),
  deploy_tx: Schema.NullOr(Schema.String),
  trigger: Schema.NullOr(Schema.String),
  activated_at: Schema.NullOr(Schema.String),
})
export type ActivationRow = typeof ActivationRow.Type

const toActivation = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(ActivationRow)(row).pipe(
    Effect.mapError(error => new DbError({ operation: 'decode wallet_activations', message: String(error) })),
  )

export const activationOf = (walletId: string) =>
  first(
    sql(
      `SELECT wallet_id, status, deployer, salt, claim_token, claimed_at, deploy_tx, trigger, activated_at
         FROM wallet_activations WHERE wallet_id = ?`,
      walletId,
    ),
    toActivation,
  )

/** What /api and the tools say about the account: deployed, or waiting for its first USDC. */
export const accountStatusOf = (walletId: string) =>
  Effect.map(activationOf(walletId), row =>
    row === undefined || row.status === 'active' ? ('active' as const) : ('awaiting_deposit' as const),
  )

export type ActivationTrigger = 'deposit' | 'allowance' | 'claim'

/**
 * Deploy a deposit-first wallet's smart account at its planned id (passkey as rule 0), once: claim the row (one deployer
 * per wallet; a stale or failed claim is taken over), deploy, record. A wallet deployed at signup, or already
 * activated, returns `tx` null and nothing is submitted. A concurrent request fails `busy`.
 */
export const activateWallet = (wallet: Wallet, trigger: ActivationTrigger) =>
  Effect.gen(function* () {
    const row = yield* activationOf(wallet.id)
    if (row === undefined || row.status === 'active') return { tx: null, activated: false }
    const now = yield* DateTime.now
    const token = yield* randomId('act')
    yield* write(
      sql(
        `UPDATE wallet_activations SET status = 'deploying', claim_token = ?, claimed_at = ?
           WHERE wallet_id = ? AND (status IN ('awaiting_deposit', 'failed') OR (status = 'deploying' AND claimed_at < ?))`,
        token,
        iso(now),
        wallet.id,
        iso(DateTime.subtractDuration(now, CLAIM_STALE)),
      ),
    )
    const claimed = yield* activationOf(wallet.id)
    if (claimed?.status === 'active') return { tx: null, activated: false }
    if (claimed?.claim_token !== token)
      return yield* new DepositError({ reason: 'busy', message: 'wallet_activating: retry in a few seconds' })
    const owner = yield* Effect.all({
      pubkey: b64urlDecode(wallet.passkey_public_key),
      credentialId: b64urlDecode(wallet.passkey_credential_id),
    }).pipe(Effect.mapError(error => new DepositError({ reason: 'chain', message: error.message })))
    const deployed = yield* Chain.use(chain =>
      chain.deployPlannedAccount(owner, {
        contractId: wallet.contract_id,
        deployer: claimed.deployer,
        salt: claimed.salt,
      }),
    ).pipe(
      Effect.tapError(() =>
        write(
          sql(
            `UPDATE wallet_activations SET status = 'failed' WHERE wallet_id = ? AND claim_token = ?`,
            wallet.id,
            token,
          ),
        ).pipe(Effect.ignore),
      ),
      Effect.mapError(fromChain),
    )
    const done = iso(yield* DateTime.now)
    yield* write(
      sql(
        `UPDATE wallet_activations SET status = 'active', deploy_tx = ?, trigger = ?, activated_at = ?
           WHERE wallet_id = ? AND claim_token = ?`,
        deployed.tx,
        trigger,
        done,
        wallet.id,
        token,
      ),
      sql('UPDATE wallets SET deploy_tx = COALESCE(deploy_tx, ?) WHERE id = ?', deployed.tx, wallet.id),
    )
    return { tx: deployed.tx, activated: true }
  })

/**
 * A deposit-first wallet whose USDC arrived (swept from the deposit address, or paid to its planned `C…`): deploy it.
 * Nothing for a deployed wallet (one row read). `justSwept` skips the balance read after a sweep that moved USDC.
 */
export const activateIfFunded = (walletId: string, justSwept = 0n) =>
  Effect.gen(function* () {
    const row = yield* activationOf(walletId)
    if (row === undefined || row.status === 'active') return null
    const wallet = yield* walletById(walletId)
    if (wallet === undefined) return null
    const held =
      justSwept > 0n
        ? justSwept
        : yield* Chain.use(chain => chain.balances(wallet.contract_id)).pipe(
            Effect.map(b => b.usdc),
            Effect.orElseSucceed(() => 0n),
          )
    if (held <= 0n) return null
    return yield* activateWallet(wallet, 'deposit')
  })
