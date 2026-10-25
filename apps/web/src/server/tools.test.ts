import { Effect, ManagedRuntime, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { describe, expect, test } from 'vitest'

import { it } from '@effect/vitest'
import {
  Chain,
  type FixtureChain,
  fixtureAssertion,
  makeFixtureChain,
  toStroops,
  type WebAuthnAssertion,
} from '@hm/protocol'
import { SoftPasskey } from '@hm/stellar/testing'

import { Ledger } from './ledger.ts'
import type { ConnectionProps } from './props.ts'
import { ownerRoute } from './routes.ts'
import { insert, write } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { createContact, createSession, receiptOfIntent } from './store.ts'
import { testServices } from './test/layers.ts'
import { BOB } from './test/seed.ts'
import { paymentExecute, paymentPrepare, paymentStatus, ToolError, type ToolContext } from './tools.ts'

/**
 * The tools against the FixtureChain and SQLite, through the same services the Worker runs. Covers acceptance tests
 * 2 (over the allowance → owner lane, never signed), 4 (the approval binds the intent), 5 (idempotent repeat),
 * 6 (revoked → refused) and 7 (a receipt only after confirmation).
 */

const ORIGIN = 'https://wallet.test'
const OWNER = 'own_t'
const WALLET = 'wal_t'
const CONNECTION = 'con_t'
const GRANT = 'gr_t'

/** A deployed, funded fixture wallet with a 5 USDC grant installed, its rows in the database, and Bob saved. */
const world = (passkey: SoftPasskey) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    const { contractId } = yield* chain.deployAccount({
      pubkey: passkey.publicKey65,
      credentialId: passkey.credentialId,
    })
    yield* chain.fundNewWallet(contractId, toStroops('30'))
    const signer = yield* chain.newSigner
    const prepared = yield* chain.prepareInstallGrant(contractId, signer.publicKey, toStroops('5'), 86_400)
    const installed = yield* chain.installGrant(prepared, fixtureAssertion(prepared.challenge))
    const now = '2026-10-25T12:00:00.000Z'
    yield* write(
      insert('owners', { id: OWNER, created_at: now }),
      insert('wallets', {
        id: WALLET,
        owner_id: OWNER,
        name: 'Personal',
        contract_id: contractId,
        passkey_credential_id: Base64Url.encode(passkey.credentialId),
        passkey_public_key: Base64Url.encode(passkey.publicKey65),
        network: 'stellar:testnet',
        deploy_tx: null,
        fund_tx: null,
        created_at: now,
      }),
      insert('connections', {
        id: CONNECTION,
        owner_id: OWNER,
        wallet_id: WALLET,
        oauth_client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
        oauth_client_name: 'Claude Code',
        oauth_client_domain: 'claude.ai',
        oauth_grant_id: CONNECTION,
        status: 'active',
        created_at: now,
        revoked_at: null,
      }),
      insert('spending_grants', {
        id: GRANT,
        connection_id: CONNECTION,
        wallet_id: WALLET,
        signer_public_key: signer.address,
        signer_key_ref: signer.signerKeyRef,
        asset: 'USDC',
        total: toStroops('5'),
        spent: 0n,
        reserved: 0n,
        valid_until: '2099-01-01T00:00:00.000Z',
        valid_until_ledger: installed.validUntilLedger,
        rule_id: installed.ruleId,
        rule_status: 'installed',
        pocket_address: signer.address,
        pocket_balance: 0n,
        first_payment_done: false,
        status: 'active',
        install_tx: installed.tx,
        created_at: now,
      }),
    )
    yield* createContact({
      ownerId: OWNER,
      displayName: 'Bob',
      aliases: [],
      address: BOB,
      memo: null,
      readiness: 'usdc_ready',
    })
    const props: ConnectionProps = {
      owner_id: OWNER,
      wallet_id: WALLET,
      connection_id: CONNECTION,
      client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
      client_name: 'Claude Code',
      client_domain: 'claude.ai',
      granted_at: now,
      grant: {
        grant_id: GRANT,
        allowance: '5.00',
        valid_until: '2099-01-01T00:00:00.000Z',
        rule_id: installed.ruleId,
        signer_public_key: signer.address,
      },
    }
    const ctx: ToolContext = { props, origin: ORIGIN }
    return { ctx, contractId }
  })

const prepare = (ctx: ToolContext, amount: string, key: string) =>
  paymentPrepare(ctx, { recipient: 'Bob', amount, reason: 'dinner', idempotency_key: key })

const transfers = (fixture: FixtureChain) => fixture.callsOf('delegatedTransfer').length

describe('the MCP tools on the fixture chain', () => {
  it.effect('2: a payment above the remaining allowance goes to the owner lane and is never signed', () => {
    const fixture = makeFixtureChain()
    return Effect.gen(function* () {
      const { ctx } = yield* world(yield* Effect.promise(() => SoftPasskey.create('wallet.test', ORIGIN)))
      const big = yield* prepare(ctx, '20', 'dinner-1')
      expect(big.value.status).toBe('awaiting_approval')
      expect(big.value.lane).toBe('owner')
      expect(big.value.approval_url).toBe(`${ORIGIN}/approve/${big.value.payment_id}`)
      expect(big.sentence).toContain(big.value.approval_url ?? 'missing')
      const executed = yield* paymentExecute(ctx, big.value.payment_id)
      expect(executed.value.status).toBe('awaiting_approval')
      expect(transfers(fixture)).toBe(0)
      expect(big.value.grant_remaining).toBe('5.00')
    }).pipe(Effect.provide(testServices(fixture)))
  })

  it.effect('5: the same idempotency key returns the same intent, and a repeated execute pays once', () => {
    const fixture = makeFixtureChain()
    return Effect.gen(function* () {
      const { ctx } = yield* world(yield* Effect.promise(() => SoftPasskey.create('wallet.test', ORIGIN)))
      const first = yield* prepare(ctx, '2', 'alice-1')
      const again = yield* prepare(ctx, '2', 'alice-1')
      expect(again.value.payment_id).toBe(first.value.payment_id)
      const paid = yield* paymentExecute(ctx, first.value.payment_id)
      const repeat = yield* paymentExecute(ctx, first.value.payment_id)
      expect(paid.value.status).toBe('confirmed')
      expect(repeat.value.receipt?.tx_hash).toBe(paid.value.receipt?.tx_hash)
      expect(transfers(fixture)).toBe(1)
      expect(repeat.value.grant_remaining).toBe('3.00')
      const reused = yield* Effect.flip(prepare(ctx, '3', 'alice-1'))
      expect(reused.message).toContain('different request')
    }).pipe(Effect.provide(testServices(fixture)))
  })

  it.effect('6: after a revoke the connection cannot prepare or execute', () => {
    const fixture = makeFixtureChain()
    return Effect.gen(function* () {
      const { ctx } = yield* world(yield* Effect.promise(() => SoftPasskey.create('wallet.test', ORIGIN)))
      const ready = yield* prepare(ctx, '1', 'before-revoke')
      yield* Ledger.use(ledger => ledger.revokeConnection(WALLET, { connectionId: CONNECTION }))
      const refused = yield* Effect.flip(prepare(ctx, '1', 'after-revoke'))
      expect(refused).toBeInstanceOf(ToolError)
      const execute = yield* Effect.flip(paymentExecute(ctx, ready.value.payment_id))
      expect(execute.message).toContain('revoked')
      expect(transfers(fixture)).toBe(0)
    }).pipe(Effect.provide(testServices(fixture)))
  })

  it.effect('7: no receipt until the chain confirms; an unknown outcome keeps the claim and never resubmits', () => {
    const fixture = makeFixtureChain()
    return Effect.gen(function* () {
      const { ctx } = yield* world(yield* Effect.promise(() => SoftPasskey.create('wallet.test', ORIGIN)))
      const lost = yield* prepare(ctx, '1', 'lost-1')
      fixture.failNext('delegatedTransfer', 'unknown')
      const pending = yield* paymentExecute(ctx, lost.value.payment_id)
      expect(pending.value.status).toBe('submitted')
      expect(pending.value.receipt).toBeNull()
      expect(yield* receiptOfIntent(lost.value.payment_id)).toBeUndefined()
      yield* paymentExecute(ctx, lost.value.payment_id)
      expect(transfers(fixture)).toBe(1)
      const failed = yield* prepare(ctx, '1', 'fail-1')
      fixture.failNext('delegatedTransfer', 'submit_failed')
      const result = yield* paymentExecute(ctx, failed.value.payment_id)
      expect(result.value.status).toBe('failed')
      expect(result.value.receipt).toBeNull()
      const status = yield* paymentStatus(ctx, failed.value.payment_id)
      expect(status.value.receipt).toBeNull()
    }).pipe(Effect.provide(testServices(fixture)))
  })

  it.effect('2: the policy refusing (#3221) at execute time routes to the owner without paying', () => {
    const fixture = makeFixtureChain()
    return Effect.gen(function* () {
      const { ctx } = yield* world(yield* Effect.promise(() => SoftPasskey.create('wallet.test', ORIGIN)))
      const small = yield* prepare(ctx, '1', 'limit-1')
      fixture.failNext('delegatedTransfer', 'limit_exhausted')
      const result = yield* paymentExecute(ctx, small.value.payment_id)
      expect(result.value.status).toBe('awaiting_approval')
      expect(result.value.approval_url).not.toBeNull()
      expect(result.value.grant_remaining).toBe('5.00')
    }).pipe(Effect.provide(testServices(fixture)))
  })
})

const body = (passkey: SoftPasskey, assertion: WebAuthnAssertion) =>
  JSON.stringify({
    assertion: {
      credential_id: Base64Url.encode(passkey.credentialId),
      client_data_json: Base64Url.encode(assertion.clientDataJSON),
      authenticator_data: Base64Url.encode(assertion.authenticatorData),
      signature: Base64Url.encode(assertion.signature),
    },
  })

const challengeOf = (text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ challenge: Schema.String })))(text).challenge

describe('the approval page', () => {
  test('4: the passkey signs one intent; its assertion does not approve another, and opening has no effect', async () => {
    const fixture = makeFixtureChain()
    const runtime: AppRuntime = ManagedRuntime.make(testServices(fixture))
    try {
      const passkey = await SoftPasskey.create('wallet.test', ORIGIN)
      const { ctx, contractId } = await runtime.runPromise(world(passkey))
      const token = await runtime.runPromise(createSession(OWNER))
      const dinner = await runtime.runPromise(prepare(ctx, '20', 'dinner-a'))
      const other = await runtime.runPromise(prepare(ctx, '15', 'dinner-b'))
      const call = async (path: string, payload?: string) => {
        const request = new Request(`${ORIGIN}${path}`, {
          method: payload === undefined ? 'GET' : 'POST',
          headers: { cookie: `hm_owner=${token}`, 'content-type': 'application/json' },
          ...(payload === undefined ? {} : { body: payload }),
        })
        const response = await ownerRoute(runtime, request, path)
        if (response === undefined) throw new Error(`no route for ${path}`)
        return { status: response.status, text: await response.text() }
      }
      const status = async (id: string) => (await runtime.runPromise(paymentStatus(ctx, id))).value

      const page = await call(`/approve/${dinner.value.payment_id}`)
      expect(page.status).toBe(200)
      expect(page.text).toContain('20.00')
      expect(page.text).toContain(BOB)
      expect((await status(dinner.value.payment_id)).status).toBe('awaiting_approval')

      const preparedA = await call(`/approve/${dinner.value.payment_id}/prepare`, '{}')
      const preparedB = await call(`/approve/${other.value.payment_id}/prepare`, '{}')
      const challengeA = challengeOf(preparedA.text)
      const challengeB = challengeOf(preparedB.text)
      expect(challengeA).not.toBe(challengeB)

      const signedA = await passkey.assertChallenge(challengeA)
      const wrong = await call(`/approve/${other.value.payment_id}`, body(passkey, signedA))
      expect(wrong.status).toBe(401)
      expect((await status(other.value.payment_id)).status).toBe('awaiting_approval')

      const right = await call(`/approve/${dinner.value.payment_id}`, body(passkey, signedA))
      expect(right.status).toBe(200)
      const settled = await status(dinner.value.payment_id)
      expect(settled.status).toBe('confirmed')
      expect(settled.receipt?.lane).toBe('owner')
      expect(settled.grant_remaining).toBe('5.00')
      expect(fixture.balanceOf(BOB)).toBe(toStroops('20'))
      expect(fixture.balanceOf(contractId)).toBe(toStroops('10'))
      expect(transfers(fixture)).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })
})
