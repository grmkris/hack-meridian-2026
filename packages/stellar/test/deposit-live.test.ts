import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Schema } from 'effect'
/**
 * Live testnet proof of deposit addresses (docs/spikes/s8-deposit.md), behind STELLAR_LIVE=1 with the keys in
 * packages/stellar/.env: a fresh passkey wallet C → createDepositAddress (sponsored G, register, lock) → G is locked
 * (master weight 0, no signers) → the treasury, a classic account like an exchange, pays G with a plain payment → the
 * permissionless sweep moves it into C → a second deposit is swept too → a sweep of an empty G submits nothing → a
 * sweep naming another wallet is refused → teardown merges G back into the relayer. Hashes and fees go to
 * .local/deposit-live-<time>.json (gitignored).
 *
 *   STELLAR_LIVE=1 bunx vitest run --root packages/stellar test/deposit-live.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { Chain, ChainError, type DepositAddress } from '@hm/protocol'
import { Asset, Keypair, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk'

import { makeSoroban, stellarLayer, StellarOps, TESTNET, USDC_ISSUER } from '../src/index.ts'
import { SoftPasskey } from '../src/testing.ts'

const LIVE = process.env['STELLAR_LIVE'] === '1'
const USDC = (n: number) => BigInt(Math.round(n * 1e7))

const envFile = (): Record<string, string> => {
  const text = readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8')
  return Object.fromEntries(
    text
      .split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  )
}

const log: Record<string, unknown> = { startedAt: new Date().toISOString() }
const record = (step: string, value: unknown) => {
  log[step] = value
  console.log(`[deposit] ${step}: ${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
}
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap(r =>
        r._tag === 'Fail' && Schema.is(ChainError)(r.error) ? [`${r.error.kind}: ${r.error.message}`] : [],
      )
    : []

describe.skipIf(!LIVE)('deposit addresses on Stellar testnet (live)', () => {
  const env = LIVE ? envFile() : {}
  const runtime = LIVE
    ? ManagedRuntime.make(
        stellarLayer(globalThis.fetch.bind(globalThis)).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        ),
      )
    : undefined
  const run = <A>(effect: Effect.Effect<A, ChainError, Chain | StellarOps>) => {
    if (runtime === undefined) throw new Error('not live')
    return runtime.runPromise(effect)
  }
  const runExit = <A>(effect: Effect.Effect<A, ChainError, Chain | StellarOps>) => {
    if (runtime === undefined) throw new Error('not live')
    return runtime.runPromiseExit(effect)
  }
  const chain = Effect.gen(function* () {
    return yield* Chain
  })
  const soroban = makeSoroban(TESTNET)
  const usdc = new Asset('USDC', USDC_ISSUER)
  const state: { contractId?: string; deposit?: DepositAddress } = {}

  /** The treasury pays G like an exchange withdrawal: a classic payment, no Soroban, no memo. */
  const exchangePays = async (to: string, amount: bigint) => {
    const treasury = Keypair.fromSecret(env['TREASURY_SECRET'] ?? '')
    const seq = await Effect.runPromise(soroban.sequence(treasury.publicKey()))
    const tx = new TransactionBuilder(new (await import('@stellar/stellar-sdk')).Account(treasury.publicKey(), seq), {
      fee: '1000',
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.payment({ destination: to, asset: usdc, amount: (Number(amount) / 1e7).toFixed(7) }))
      .setTimeout(120)
      .build()
    tx.sign(treasury)
    return Effect.runPromise(soroban.sendAndPoll(tx))
  }

  const costOf = async (hash: string) => {
    const o = await Effect.runPromise(soroban.getTransaction(hash))
    return { tx: hash, ledger: o.ledger, feeStroops: o.feeCharged, rentStroops: o.rentCharged ?? null }
  }

  /** G's account entry: master weight, thresholds, signers (kinds), sponsor, subentries. */
  const accountOf = async (g: string) => {
    const kp = Keypair.fromPublicKey(g)
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }))
    const r = await soroban.server.getLedgerEntries(key)
    const entry = r.entries[0]
    if (entry === undefined) return null
    const a = entry.val.account()
    const ext = a.ext()
    const sponsor = ext.switch() === 1 && ext.v1().ext().switch() === 2 ? 'sponsoring entries present' : 'no v2 ext'
    return {
      balanceStroops: a.balance().toString(),
      thresholds: [...a.thresholds()],
      signers: a.signers().length,
      signerKinds: a.signers().map(x => x.key().switch().name),
      subentries: a.numSubEntries(),
      sponsorExt: sponsor,
    }
  }

  it('creates a passkey wallet C', async () => {
    const passkey = await SoftPasskey.create()
    const deployed = await run(Effect.flatMap(chain, c => c.deployAccount(passkey.owner)))
    record('deploy', deployed)
    expect(deployed.contractId).toMatch(/^C[A-Z2-7]{55}$/u)
    state.contractId = deployed.contractId
  }, 120_000)

  it('creates its deposit address: sponsored G, registered with the router, master weight 0', async () => {
    const contractId = state.contractId
    if (contractId === undefined) throw new Error('no wallet')
    const deposit = await run(Effect.flatMap(chain, c => c.createDepositAddress(contractId)))
    state.deposit = deposit
    record('createDepositAddress', { ...deposit, teardownXdr: `${deposit.teardownXdr.length} bytes` })
    record('cost.create', await costOf(deposit.txs.create))
    record('cost.register', await costOf(deposit.txs.register))
    record('cost.lock', await costOf(deposit.txs.lock))
    const account = await accountOf(deposit.address)
    record('G.account', account)
    // Master weight 0 (thresholds[0]), 0 XLM, one signer (the teardown's pre-auth hash), two subentries (+ trustline).
    expect(account).toMatchObject({ balanceStroops: '0', signers: 1, subentries: 2 })
    expect(account?.thresholds[0]).toBe(0)
    expect(deposit.recipient).toBe(contractId)
  }, 180_000)

  it('the exchange pays 2 USDC to G; the permissionless sweep moves it into C', async () => {
    const { contractId, deposit } = state
    if (contractId === undefined || deposit === undefined) throw new Error('no deposit address')
    const paid = await exchangePays(deposit.address, USDC(2))
    record('exchangePays.1', { tx: paid.hash, feeStroops: paid.feeCharged })
    const swept = await run(Effect.flatMap(chain, c => c.sweepDeposit(deposit.address, contractId)))
    record('sweep.1', swept && { amount: swept.amountStroops, ...(await costOf(swept.receipt.tx)) })
    expect(swept?.amountStroops).toBe(USDC(2))
    const balances = await run(Effect.flatMap(chain, c => c.balances(contractId)))
    record('C.balance.1', balances)
    expect(balances.usdc).toBe(USDC(2))
    expect((await run(Effect.flatMap(chain, c => c.balances(deposit.address)))).usdc).toBe(0n)
  }, 180_000)

  it('a second deposit (0.75) lands too; an empty G sweeps nothing; another wallet is refused', async () => {
    const { contractId, deposit } = state
    if (contractId === undefined || deposit === undefined) throw new Error('no deposit address')
    const paid = await exchangePays(deposit.address, USDC(0.75))
    record('exchangePays.2', { tx: paid.hash })
    const other = await runExit(
      Effect.flatMap(chain, c => c.sweepDeposit(deposit.address, TESTNET.contracts.onboardRouter)),
    )
    record('sweep.otherWallet', failure(other))
    expect(failure(other).join(' ')).toContain('deposit_mismatch')
    const swept = await run(Effect.flatMap(chain, c => c.sweepDeposit(deposit.address, contractId)))
    record('sweep.2', swept && { amount: swept.amountStroops, ...(await costOf(swept.receipt.tx)) })
    expect(swept?.amountStroops).toBe(USDC(0.75))
    const empty = await run(Effect.flatMap(chain, c => c.sweepDeposit(deposit.address, contractId)))
    record('sweep.empty', empty)
    expect(empty).toBeNull()
    const balances = await run(Effect.flatMap(chain, c => c.balances(contractId)))
    record('C.balance.2', balances)
    expect(balances.usdc).toBe(USDC(2.75))
  }, 180_000)

  it('teardown: the pre-signed merge, fee-bumped by a relayer, closes G and returns the reserves', async () => {
    const { deposit } = state
    if (deposit === undefined) throw new Error('no deposit address')
    const closed = await run(
      Effect.flatMap(
        Effect.gen(function* () {
          return yield* StellarOps
        }),
        o => o.closeDeposit(deposit.address, deposit.teardownXdr),
      ),
    )
    record('closeDeposit', { tx: closed.tx, feeStroops: closed.feeStroops, feePayer: closed.feePayer })
    expect(await accountOf(deposit.address)).toBeNull()
  }, 120_000)

  afterAll(async () => {
    if (!LIVE) return
    mkdirSync(join(import.meta.dirname, '..', '..', '..', '.local'), { recursive: true })
    const file = join(import.meta.dirname, '..', '..', '..', '.local', `deposit-live-${Date.now()}.json`)
    writeFileSync(
      file,
      JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    )
    console.log(`[deposit] evidence: ${file}`)
    await runtime?.dispose()
  })
})
