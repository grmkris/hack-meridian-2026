import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Schema } from 'effect'
/**
 * Live testnet run of the whole Chain, behind STELLAR_LIVE=1 (keys from packages/stellar/.env, made by
 * scripts/treasury.ts). One wallet's life: deploy (software passkey) → fund → install grant (passkey) → pocket →
 * delegated pull → over-limit refusal at the enforce simulation → x402 purchase from the pocket → owner transfer
 * (passkey) → CAP-73 claim to a G without a trustline → remove grant → refusal after revoke → sweep → close.
 * Every hash goes to .local/stellar-live-<time>.json (gitignored).
 *
 *   STELLAR_LIVE=1 bunx vitest run --root packages/stellar test/live.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { Chain, ChainError, type Receipt } from '@hm/protocol'
import { Keypair } from '@stellar/stellar-sdk'

import { ownerOneShot, SPENDING_LIMIT_POLICY, stellarLayer, StellarOps } from '../src/index.ts'
import { SoftPasskey } from '../src/testing.ts'
import { sellerRound, treasuryAddressOf } from './workerd/seller-round.ts'

const LIVE = process.env['STELLAR_LIVE'] === '1'
const USDC = (n: number) => BigInt(Math.round(n * 1e7))
const XLM = USDC
const DEMO_SELLER = process.env['X402_DEMO_URL'] ?? 'https://stellar.org/x402-demo/api/protected/testnet'
/** The demo seller Worker (apps/seller, stream C). */
const SELLER_URL = process.env['SELLER_URL'] ?? 'https://hm26-seller.kristjan-grm11775.workers.dev'

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
  console.log(`[live] ${step}: ${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
}
const failureKind = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap(r => (r._tag === 'Fail' && Schema.is(ChainError)(r.error) ? [r.error.kind] : []))
    : []
const receiptRow = (r: Receipt) => ({ tx: r.tx, ledger: r.ledger, feeStroops: r.feeStroops, feePayer: r.feePayer })

describe.skipIf(!LIVE)('Chain on Stellar testnet (live)', () => {
  const runtime = LIVE
    ? ManagedRuntime.make(
        stellarLayer(globalThis.fetch.bind(globalThis)).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(envFile()))),
        ),
      )
    : undefined
  const run = <A>(effect: Effect.Effect<A, ChainError, Chain | StellarOps>) => {
    if (runtime === undefined) throw new Error('not live')
    return runtime.runPromise(effect)
  }
  const runExit = <A>(effect: Effect.Effect<A, ChainError, Chain | StellarOps>): Promise<Exit.Exit<A, unknown>> => {
    if (runtime === undefined) throw new Error('not live')
    return runtime.runPromiseExit(effect)
  }
  const chain = Effect.gen(function* () {
    return yield* Chain
  })
  const ops = Effect.gen(function* () {
    return yield* StellarOps
  })
  const state: {
    passkey?: SoftPasskey
    contractId?: string
    signer?: { signerKeyRef: string; publicKey: Uint8Array; address: string }
    ruleId?: number
  } = {}

  it('health: relayers funded, rent factor read live', async () => {
    const h = await run(Effect.flatMap(chain, c => c.health))
    record('health', h)
    expect(h.relayers.length).toBeGreaterThan(0)
    expect(h.relayers.every(r => r.xlmStroops > XLM(100))).toBe(true)
    expect(h.rentFactor).not.toBeNull()
  })

  it('deploys a passkey-owned account and funds it from the treasury', async () => {
    state.passkey = await SoftPasskey.create()
    const owner = state.passkey.owner
    const deployed = await run(Effect.flatMap(chain, c => c.deployAccount(owner)))
    record('deploy', deployed)
    state.contractId = deployed.contractId
    const contractId = deployed.contractId
    expect(await run(Effect.flatMap(chain, c => c.readiness(contractId)))).toBe('contract')
    const funded = await run(Effect.flatMap(chain, c => c.fundNewWallet(contractId, USDC(3))))
    record('fund', funded)
    expect((await run(Effect.flatMap(chain, c => c.balances(contractId)))).usdc).toBe(USDC(3))
  }, 120_000)

  it('installs a 1 USDC / 1 h grant with the passkey and reads it back', async () => {
    const { passkey, contractId } = state
    if (passkey === undefined || contractId === undefined) throw new Error('no wallet')
    const signer = await run(Effect.flatMap(chain, c => c.newSigner))
    state.signer = signer
    const overCap = await runExit(
      Effect.flatMap(chain, c => c.prepareInstallGrant(contractId, signer.publicKey, USDC(25), 3600)),
    )
    record('grant.overCap', failureKind(overCap))
    expect(failureKind(overCap)).toEqual(['declined'])
    const prepared = await run(
      Effect.flatMap(chain, c => c.prepareInstallGrant(contractId, signer.publicKey, USDC(1), 3600)),
    )
    const assertion = await passkey.assertChallenge(prepared.challenge)
    const installed = await run(Effect.flatMap(chain, c => c.installGrant(prepared, assertion)))
    record('installGrant', installed)
    state.ruleId = installed.ruleId
    const grant = await run(Effect.flatMap(chain, c => c.readGrant(contractId, installed.ruleId)))
    record('readGrant.fresh', grant)
    expect(grant).toMatchObject({ spent: 0n, limit: USDC(1), live: true, validUntilLedger: installed.validUntilLedger })
  }, 120_000)

  it('creates the pocket, pulls 0.30 under the rule, refuses an over-limit pull before submitting', async () => {
    const { contractId, signer, ruleId } = state
    if (contractId === undefined || signer === undefined || ruleId === undefined) throw new Error('no grant')
    const pocket = await run(Effect.flatMap(chain, c => c.createPocket(signer.signerKeyRef)))
    record('createPocket', pocket)
    expect(pocket.address).toBe(signer.address)
    expect(await run(Effect.flatMap(chain, c => c.readiness(pocket.address)))).toBe('usdc_ready')
    const pull = await run(
      Effect.flatMap(chain, c =>
        c.delegatedTransfer(contractId, ruleId, signer.signerKeyRef, pocket.address, USDC(0.3)),
      ),
    )
    record('pull.first', receiptRow(pull))
    expect((await run(Effect.flatMap(chain, c => c.readGrant(contractId, ruleId)))).spent).toBe(USDC(0.3))
    const over = await runExit(
      Effect.flatMap(chain, c =>
        c.delegatedTransfer(contractId, ruleId, signer.signerKeyRef, pocket.address, USDC(0.8)),
      ),
    )
    record('pull.overLimit', failureKind(over))
    expect(failureKind(over)).toEqual(['limit_exhausted'])
  }, 180_000)

  it('pays an x402 resource from the pocket (stock client, hosted facilitator)', async () => {
    const { signer } = state
    if (signer === undefined) throw new Error('no signer')
    const quotes: Array<unknown> = []
    const paid = await run(
      Effect.flatMap(chain, c =>
        c.payX402(signer.signerKeyRef, DEMO_SELLER, USDC(0.05), `a2_live_${Date.now()}_x402`, quote =>
          Effect.sync(() => {
            quotes.push(quote)
          }),
        ),
      ),
    )
    record('x402', { status: paid.body.status, quote: paid.quote, settlement: paid.settlement })
    expect(paid.body.status).toBe(200)
    expect(paid.settlement?.tx).toMatch(/^[0-9a-f]{64}$/u)
    expect(paid.settlement?.feePayer).not.toBe(signer.address)
    expect(quotes).toHaveLength(1)
  }, 120_000)

  it('owner transfer with the passkey does not consume the grant', async () => {
    const { passkey, contractId, ruleId } = state
    if (passkey === undefined || contractId === undefined || ruleId === undefined) throw new Error('no wallet')
    const before = await run(Effect.flatMap(chain, c => c.readGrant(contractId, ruleId)))
    const env = envFile()
    const to = Keypair.fromSecret(env['TREASURY_SECRET'] ?? '').publicKey()
    const prepared = await run(Effect.flatMap(chain, c => c.prepareOwnerTransfer(contractId, to, USDC(0.5), 400)))
    const assertion = await passkey.assertChallenge(prepared.challenge)
    const receipt = await run(Effect.flatMap(chain, c => c.finalizeOwnerTransfer(prepared, assertion)))
    record('ownerTransfer', receiptRow(receipt))
    const after = await run(Effect.flatMap(chain, c => c.readGrant(contractId, ruleId)))
    expect(after.spent).toBe(before.spent)
  }, 120_000)

  it('CAP-73 claim: a G without a trustline gets trust + transfer in one invocation, sender under the rule', async () => {
    const { contractId, signer, ruleId } = state
    if (contractId === undefined || signer === undefined || ruleId === undefined) throw new Error('no grant')
    const env = envFile()
    const carol = Keypair.fromSecret(env['DEMO_RECIPIENT_SECRET'] ?? '')
    const readiness = await run(Effect.flatMap(chain, c => c.readiness(carol.publicKey())))
    record('claim.recipientReadiness', readiness)
    expect(readiness).toBe('trustline_required')
    const prepared = await run(
      Effect.flatMap(chain, c => c.prepareClaim(contractId, carol.publicKey(), USDC(0.2), 720)),
    )
    expect(prepared.recipientEntryXdr).not.toBe('')
    const signed = await run(Effect.flatMap(chain, c => c.signClaimAsDemoRecipient(prepared)))
    const receipt = await run(
      Effect.flatMap(chain, c =>
        c.finalizeClaim(prepared, signed, { _tag: 'Delegated', ruleId, signerKeyRef: signer.signerKeyRef }),
      ),
    )
    record('claim', receiptRow(receipt))
    expect(await run(Effect.flatMap(chain, c => c.readiness(carol.publicKey())))).toBe('usdc_ready')
    expect((await run(Effect.flatMap(chain, c => c.balances(carol.publicKey())))).usdc).toBe(USDC(0.2))
  }, 120_000)

  it('removes the grant with the passkey; the next delegated pull is refused (#3000)', async () => {
    const { passkey, contractId, signer, ruleId } = state
    if (passkey === undefined || contractId === undefined || signer === undefined || ruleId === undefined)
      throw new Error('no grant')
    // The one-shot form: prepare → passkey signs the challenge → finalize.
    const removed = await run(
      Effect.flatMap(chain, c =>
        ownerOneShot(
          c.prepareRemoveGrant(contractId, ruleId),
          challenge => Effect.promise(() => passkey.assertChallenge(challenge)),
          c.removeGrant,
        ),
      ),
    )
    record('removeGrant', removed)
    const grant = await run(Effect.flatMap(chain, c => c.readGrant(contractId, ruleId)))
    expect(grant.live).toBe(false)
    const after = await runExit(
      Effect.flatMap(chain, c =>
        c.delegatedTransfer(contractId, ruleId, signer.signerKeyRef, signer.address, USDC(0.01)),
      ),
    )
    record('pull.afterRevoke', failureKind(after))
    expect(failureKind(after)).toEqual(['removed'])
  }, 120_000)

  it('sweeps the pocket float back to the wallet and closes the pocket', async () => {
    const { contractId, signer } = state
    if (contractId === undefined || signer === undefined) throw new Error('no pocket')
    const float = (await run(Effect.flatMap(chain, c => c.balances(signer.address)))).usdc
    const before = (await run(Effect.flatMap(chain, c => c.balances(contractId)))).usdc
    const swept = await run(Effect.flatMap(chain, c => c.sweepPocket(signer.signerKeyRef, contractId)))
    record('sweep', { float, ...receiptRow(swept) })
    expect((await run(Effect.flatMap(chain, c => c.balances(contractId)))).usdc).toBe(before + float)
    const closed = await run(Effect.flatMap(ops, o => o.closePocket(signer.signerKeyRef)))
    record('closePocket', receiptRow(closed))
    expect(await run(Effect.flatMap(chain, c => c.readiness(signer.address)))).toBe('account_missing')
  }, 120_000)

  it('reads TTLs of the wallet, the shared policy and their WASM', async () => {
    const { contractId } = state
    if (contractId === undefined) throw new Error('no wallet')
    const ttl = await run(Effect.flatMap(ops, o => o.ttlStatus([contractId, SPENDING_LIMIT_POLICY], [])))
    record('ttl', ttl)
    expect(ttl.entries.filter(e => e.kind === 'instance').every(e => e.liveUntilLedger !== null)).toBe(true)
  })

  it('pays the demo seller over HTTP and MCP from a pocket, then sweeps and closes it', async () => {
    const treasury = treasuryAddressOf(envFile()['TREASURY_SECRET'] ?? '')
    const round = await run(sellerRound(SELLER_URL, treasury, 'bun'))
    record('seller', round)
    expect(round.http.status).toBe(200)
    expect(round.http.settlement?.tx).toMatch(/^[0-9a-f]{64}$/u)
    expect(round.mcp.settlement?.tx).toMatch(/^[0-9a-f]{64}$/u)
  }, 180_000)

  afterAll(async () => {
    await runtime?.dispose()
    const dir = join(import.meta.dirname, '..', '..', '..', '.local')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `stellar-live-${Date.now()}.json`)
    writeFileSync(
      file,
      JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    )
    console.log(`[live] log → ${file}`)
  })
})
