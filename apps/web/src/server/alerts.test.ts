import { Effect, Layer, Option, Redacted } from 'effect'
import { describe, expect, test } from 'vitest'

import { Chain, makeFixtureChain } from '@hm/protocol'

import { type AlertParams, AlertStore, evaluate, floorsFor, kindKey, newAlerts, runAlerts } from './alerts.ts'
import { Network } from './network.ts'
import { structuredLoggerLayer } from './observe/log.ts'
import { testNetwork } from './test/layers.ts'

/**
 * The liveness checks of scripts/mainnet/watch.ts, in the Worker: floors per network, one alert per condition while
 * it lasts (dedupe by kind with numbers stripped), and a new alert logged at error and POSTed once.
 */

const XLM = 10_000_000n
const G = (n: number) => `G${String(n).padStart(55, 'A')}`
const health = (relayersXlm: ReadonlyArray<number>, treasuryUsdc: number, facilitatorsOk = true) => ({
  network: 'testnet',
  latestLedger: 1,
  relayers: relayersXlm.map((value, index) => ({ address: G(index), xlmStroops: BigInt(value) * XLM })),
  treasury: { address: G(9), usdcStroops: BigInt(treasuryUsdc) * XLM, xlmStroops: 100n * XLM },
  rentFactor: 0.1,
  facilitators: [{ url: 'https://www.x402.org/facilitator', ok: facilitatorsOk }],
})

describe('the alert floors', () => {
  test('testnet: relayers under 500 XLM, treasury under 60 USDC, a facilitator down, payments off, a short TTL', () => {
    const alerts = evaluate(
      {
        network: 'testnet',
        health: health([9031, 499], 23, false),
        paymentsEnabled: false,
        routers: [
          { name: 'deposit_router', id: 'CAFLFU5GH7QZ6KF3FBKRV7VW5XFYUKQPCFFTCPTKVEUG4TDT5B2ZOXGL', daysLeft: 173 },
          { name: 'onboard_router', id: 'CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4', daysLeft: 6.5 },
        ],
        toolErrors: 2,
      },
      floorsFor('testnet'),
    )
    expect(alerts.map(alert => alert.kind)).toEqual([
      `relayer.low:${G(1).slice(0, 4)}…${G(1).slice(-4)}`,
      'treasury.low',
      'facilitator.down:www.x402.org',
      'payments.disabled',
      'contract.ttl:onboard_router',
      'tools.unexpected_errors',
    ])
    expect(alerts[1]?.text).toBe('testnet treasury holds 23.00 USDC (floor 60)')
  })

  test('mainnet: relayer A under 12, B under 5; an empty treasury is fine', () => {
    const quiet = evaluate(
      { network: 'pubnet', health: health([91, 50], 0), paymentsEnabled: true, routers: [], toolErrors: 0 },
      floorsFor('pubnet'),
    )
    expect(quiet).toEqual([])
    const low = evaluate(
      { network: 'pubnet', health: health([11, 4], 0), paymentsEnabled: true, routers: [], toolErrors: 0 },
      floorsFor('pubnet'),
    )
    expect(low.map(alert => alert.text)).toEqual([
      `mainnet relayer ${G(0).slice(0, 4)}…${G(0).slice(-4)} holds 11.0 XLM (floor 12)`,
      `mainnet relayer ${G(1).slice(0, 4)}…${G(1).slice(-4)} holds 4.0 XLM (floor 5)`,
    ])
  })

  test('an unreadable health is an alert of its own', () => {
    expect(
      evaluate(
        { network: 'testnet', health: null, paymentsEnabled: true, routers: [], toolErrors: 0 },
        floorsFor('testnet'),
      ).map(alert => alert.kind),
    ).toEqual(['health.unreadable'])
  })
})

describe('dedupe', () => {
  test('a kind is new once; numbers do not make it new; gone and back is new again', () => {
    const first = newAlerts([], [{ kind: 'relayer.low:GAB1…XY2Z', text: 'a' }])
    expect(first.fresh).toHaveLength(1)
    expect(newAlerts(first.open, [{ kind: 'relayer.low:GAB1…XY2Z', text: 'b' }]).fresh).toHaveLength(0)
    expect(kindKey('relayer.low:GAB1…XY2Z')).toBe(kindKey('relayer.low:GAB7…XY9Z'))
    const cleared = newAlerts(first.open, [])
    expect(cleared.open).toEqual([])
    expect(newAlerts(cleared.open, [{ kind: 'relayer.low:GAB1…XY2Z', text: 'c' }]).fresh).toHaveLength(1)
  })
})

const run = (params: AlertParams, store: Layer.Layer<AlertStore>, sink: Array<string>, posts: Array<string>) =>
  Effect.runPromise(
    runAlerts(params, async (_url, body) => {
      posts.push(body)
      return new Response('ok')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Chain, makeFixtureChain().chain),
          Layer.succeed(Network, testNetwork),
          store,
          structuredLoggerLayer({ app: 'nod', stage: 'local', sink: (_level, line) => sink.push(line) }),
        ),
      ),
    ),
  )

describe('a run', () => {
  test('a forced floor raises one alert, POSTed once as { stage, kind, text, at }, quiet on the next run', async () => {
    const store = AlertStore.memory()
    const lines: Array<string> = []
    const posts: Array<string> = []
    const params: AlertParams = {
      stage: 'local',
      webhook: Option.some(Redacted.make('https://alerts.test/hook')),
      treasuryFloor: Option.some(1000),
      relayerFloor: Option.none(),
    }
    const first = await run(params, store, lines, posts)
    expect(first.fresh.map(alert => alert.kind)).toEqual(['treasury.low'])
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0] ?? '{}')).toMatchObject({ stage: 'local', kind: 'treasury.low' })
    expect(lines.some(line => line.includes('"msg":"alert.new"') && line.includes('"level":"error"'))).toBe(true)
    expect(lines.join('\n')).not.toContain('alerts.test/hook')
    const second = await run(params, store, lines, posts)
    expect(second.alerts).toHaveLength(1)
    expect(second.fresh).toHaveLength(0)
    expect(posts).toHaveLength(1)
  })

  test('without ALERT_WEBHOOK_URL a new alert is logged at error and nothing is POSTed', async () => {
    const lines: Array<string> = []
    const posts: Array<string> = []
    await run(
      { stage: 'local', webhook: Option.none(), treasuryFloor: Option.some(1000), relayerFloor: Option.none() },
      AlertStore.memory(),
      lines,
      posts,
    )
    expect(posts).toEqual([])
    expect(lines.some(line => line.includes('"msg":"alert.webhook_missing"'))).toBe(true)
  })

  test('the unexpected-tool-error count of the last 10 minutes raises an alert', async () => {
    const store = AlertStore.memory()
    await Effect.runPromise(AlertStore.use(s => s.toolError).pipe(Effect.provide(store)))
    const lines: Array<string> = []
    const result = await run(
      { stage: 'local', webhook: Option.none(), treasuryFloor: Option.none(), relayerFloor: Option.none() },
      store,
      lines,
      [],
    )
    expect(result.fresh.map(alert => alert.kind)).toEqual(['tools.unexpected_errors'])
  })
})
