import { Effect, Layer, ManagedRuntime, Option } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { Chain, type ChainShape, makeFixtureChain, toStroops } from '@hm/protocol'

import { Counter } from '../counter.ts'
import { Db } from '../db.ts'
import { Ledger, makeLocalLedger } from '../ledger.ts'
import { Network } from '../network.ts'
import { OAuthGrants } from '../oauth-grants.ts'
import type { AppRuntime } from '../runtime.ts'
import { testNetwork, testSettings } from '../test/layers.ts'
import { sqliteEngine } from '../test/sqlite.ts'
import { WalletCaps } from '../wallet-caps.ts'
import { WalletSettings } from '../wallet-settings.ts'
import { noRecipientReset, type RecipientReset } from './demo-recipient.ts'
import { type DeskStorage, SampleDesk } from './desk.ts'
import type { SampleRun, StartReply } from './model.ts'
import { executeSample } from './run.ts'

/**
 * The whole /sample run on the FixtureChain and SQLite, through the services the Worker runs: the demo wallet is
 * created on first use, the soft passkey installs the allowance and nods, every step lands in its state; a second
 * start while a run is going is refused; the next run renews the allowance. Carol's trustline is reset before a run
 * that finds one and after every claim; a failed reset skips the claim with its reason.
 */

const SITE = { origin: 'https://wallet.test', rpId: 'wallet.test' }
const SECRET = 'a test vault key of at least sixteen bytes'
const ALICE = 'CALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const BOB = 'GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const CAROL = 'GCAROLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const services = (chain: ChainShape) => {
  const db = Layer.unwrap(Effect.promise(async () => Db.fromEngine(await sqliteEngine())))
  return Layer.mergeAll(
    testSettings,
    Layer.succeed(WalletSettings, {
      stage: 'test',
      chain: 'fixture',
      rpId: Option.some(SITE.rpId),
      origin: Option.some(SITE.origin),
      welcomeUsdc: toStroops('10'),
      demoContacts: [
        { name: 'Alice', address: ALICE, trustline_required: false },
        { name: 'Bob', address: BOB, trustline_required: false },
        { name: 'Carol', address: CAROL, trustline_required: true },
      ],
    }),
    Layer.succeed(Chain, chain),
    OAuthGrants.none,
    Layer.succeed(Network, testNetwork),
    WalletCaps.memory(),
    Layer.succeed(Counter, { read: Effect.die('no counter in this test') }),
    Layer.effect(Ledger, makeLocalLedger),
  ).pipe(Layer.provideMerge(db))
}

/** The desk on a Map, as the Durable Object's storage holds it; `wake` is the alarm, run by the test. */
const memoryDesk = (clock: { now: number }) => {
  const store = new Map<string, unknown>()
  const storage: DeskStorage = {
    // SAFETY: the desk reads back exactly the values it put under each key.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    get: <T>(key: string) => Promise.resolve(store.get(key) as T | undefined),
    put: entries => {
      for (const [key, value] of Object.entries(entries)) store.set(key, structuredClone(value))
      return Promise.resolve()
    },
    delete: keys => {
      for (const key of keys) store.delete(key)
      return Promise.resolve()
    },
    wake: () => Promise.resolve(),
  }
  return new SampleDesk(storage, () => clock.now)
}

const states = (run: SampleRun | undefined) => run?.lines.map(line => `${line.step}:${line.state}`) ?? []

/** A run that finishes at once (the desk's limits do not depend on what a run does). */
const done = (ticket: { readonly id: string }): Promise<SampleRun> =>
  Promise.resolve({ id: ticket.id, status: 'done', created_at: '', finished_at: '', lines: [], error: null })

let runtime: AppRuntime | undefined
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

describe('the /sample run on the fixture chain', () => {
  test('the nine steps land in their states; a second start meanwhile is refused; the next run renews', async () => {
    const fixture = makeFixtureChain({ trustlineMissing: [CAROL] })
    // Carol's trustline as the chain sees it: the claim creates it, the demo recipient's reset removes it.
    const carolTrust = { value: false }
    const chain: ChainShape = {
      ...fixture.chain,
      readiness: address =>
        address === CAROL
          ? Effect.succeed(carolTrust.value ? 'usdc_ready' : 'trustline_required')
          : fixture.chain.readiness(address),
      finalizeClaim: (prepared, signed, sender) =>
        fixture.chain.finalizeClaim(prepared, signed, sender).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              carolTrust.value = true
            }),
          ),
        ),
    }
    const resets: Array<string> = []
    const recipient: RecipientReset = {
      reset: (_address, returnTo) =>
        Effect.sync(() => {
          if (!carolTrust.value) return null
          carolTrust.value = false
          resets.push(returnTo)
          return { tx: 'a'.repeat(64), returned: '1.0000000' }
        }),
    }
    const rt: AppRuntime = ManagedRuntime.make(services(chain))
    runtime = rt
    const clock = { now: Date.parse('2026-10-25T16:00:00Z') }
    const desk = memoryDesk(clock)
    const during: Array<StartReply> = []
    const execute = (
      ticket: { readonly id: string; readonly site: typeof SITE },
      report: (run: SampleRun) => Promise<void>,
    ) =>
      desk
        .start('visitor-b', SITE)
        .then(reply => during.push(reply))
        .then(() => executeSample(rt, { id: ticket.id, site: ticket.site, secret: SECRET, recipient }, report))

    const first = await desk.start('visitor-a', SITE)
    if (!first.ok) throw new Error(first.message)
    await desk.runQueued(execute, false)
    const run = await desk.status(first.id)

    expect(during).toEqual([expect.objectContaining({ ok: false, reason: 'busy', current: first.id })])
    expect(run?.status).toBe('done')
    expect(states(run)).toEqual([
      '0:ok', // demo wallet created (passkey registration → deploy → welcome USDC)
      '0:ok', // allowance installed by the soft passkey, pocket created (the 10 USDC welcome meets the floor: no top-up)
      '1:ok',
      '2:paid',
      '3:paid',
      '4:needs_nod',
      '5:nodded',
      '6:same_receipt',
      '7:left_pending',
      '8:needs_nod',
      '8:paid',
      '9:revoked',
      '9:refused',
      'end:ok', // Carol reset for the next run
      'end:ok',
    ])
    expect(carolTrust.value).toBe(false)
    expect(resets).toHaveLength(1)
    const line = (step: string, state: string) => run?.lines.find(l => l.step === step && l.state === state)
    expect(line('2', 'paid')?.amount).toBe('0.10 USDC')
    expect(line('3', 'paid')?.amount).toBe('2.00 USDC')
    expect(line('3', 'paid')?.detail).toContain('2.90 USDC left')
    expect(line('4', 'needs_nod')?.detail).toContain('More than the 2.90 USDC left')
    expect(line('5', 'nodded')?.amount).toBe('5.00 USDC')
    expect(line('5', 'nodded')?.detail).toContain('2.90 USDC left')
    expect(line('7', 'left_pending')?.amount).toBe('4.00 USDC')
    expect(line('7', 'left_pending')?.detail).toContain('2.90')
    expect(line('9', 'refused')?.detail).toContain('revoked')
    expect(fixture.balanceOf(BOB)).toBe(toStroops('5'))
    expect(fixture.callsOf('payX402')).toHaveLength(1)
    expect(fixture.callsOf('installGrant')).toHaveLength(1)
    expect(fixture.callsOf('removeGrant')).toHaveLength(1)
    expect(fixture.callsOf('sweepPocket')).toHaveLength(1)
    expect(fixture.callsOf('finalizeClaim')).toHaveLength(1)
    // The owner lane never consumed the allowance: Bob and Carol went through the passkey.
    expect(fixture.callsOf('delegatedTransfer')).toHaveLength(2)

    // The same visitor waits ten minutes; another visitor may start the next run. Meanwhile a judge onboarded Carol.
    carolTrust.value = true
    clock.now += 60_000
    const again = await desk.start('visitor-a', SITE)
    expect(again).toEqual(expect.objectContaining({ ok: false, reason: 'visitor' }))
    const next = await desk.start('visitor-c', SITE)
    if (!next.ok) throw new Error(next.message)
    await desk.runQueued(
      (ticket, report) => executeSample(rt, { id: ticket.id, site: ticket.site, secret: SECRET, recipient }, report),
      false,
    )
    const second = await desk.status(next.id)
    expect(second?.status).toBe('done')
    expect(states(second)).toEqual([
      '0:ok', // a new allowance (the last run revoked its own); the wallet is reused
      '0:ok', // top-up
      '0:ok', // Carol reset before the claim
      '1:ok',
      '2:paid',
      '3:paid',
      '4:needs_nod',
      '5:nodded',
      '6:same_receipt',
      '7:left_pending',
      '8:needs_nod',
      '8:paid',
      '9:revoked',
      '9:refused',
      'end:ok',
      'end:ok',
    ])
    expect(resets).toHaveLength(3)
    expect(fixture.callsOf('deployAccount')).toHaveLength(1)
    expect(fixture.callsOf('installGrant')).toHaveLength(2)
    expect(fixture.callsOf('finalizeClaim')).toHaveLength(2)

    // A reset that fails: the claim is skipped with the reason, and the end says Carol is still onboarded.
    carolTrust.value = true
    const third = await executeSample(
      rt,
      {
        id: 'sr_third',
        site: SITE,
        secret: SECRET,
        recipient: noRecipientReset('this stage has no demo recipient key'),
      },
      () => Promise.resolve(),
    )
    expect(third.status).toBe('done')
    const skipped = third.lines.find(l => l.step === '8')
    expect(skipped?.state).toBe('skipped')
    expect(skipped?.detail).toContain('the reset failed: this stage has no demo recipient key')
    expect(third.lines.filter(l => l.step === 'end').map(l => l.state)).toEqual(['failed', 'ok'])
  }, 30_000)

  test('an interrupted run is not repeated: a retried alarm marks it failed and frees the lock', async () => {
    const clock = { now: Date.parse('2026-10-25T16:00:00Z') }
    const desk = memoryDesk(clock)
    const first = await desk.start('visitor-a', SITE)
    if (!first.ok) throw new Error(first.message)
    let executed = 0
    await desk.runQueued(() => {
      executed += 1
      return Promise.reject(new Error('never'))
    }, true)
    expect(executed).toBe(0)
    expect((await desk.status(first.id))?.status).toBe('failed')
    expect(await desk.start('visitor-b', SITE)).toEqual(expect.objectContaining({ ok: true }))
  })

  test('at most four runs an hour across visitors', async () => {
    const clock = { now: Date.parse('2026-10-25T16:00:00Z') }
    const desk = memoryDesk(clock)
    for (let visitor = 0; visitor < 4; visitor++) {
      expect((await desk.start(`v${visitor}`, SITE)).ok).toBe(true)
      await desk.runQueued(done, false)
      clock.now += 60_000
    }
    expect(await desk.start('v5', SITE)).toEqual(expect.objectContaining({ ok: false, reason: 'hourly' }))
    clock.now += 57 * 60_000
    expect((await desk.start('v5', SITE)).ok).toBe(true)
  })
})
