import { Clock, Context, DateTime, Effect, Layer, Option, Redacted } from 'effect'

import { Chain, type ChainHealth } from '@hm/protocol'
import { StellarOps } from '@hm/stellar'

import { Network } from './network.ts'
import { logEvent, logFailure } from './observe/log.ts'
import { annotate } from './observe/redact.ts'

/**
 * The liveness watch inside the Worker (scripts/mainnet/watch.ts ported): a cron every 10 minutes reads the stage's
 * health and raises an alert for each floor crossed: relayer XLM, treasury USDC, the payments switch, a facilitator
 * that stops answering, a router whose TTL runs short, unexpected tool errors in the last 10 minutes. An alert is new
 * the first run its kind (numbers stripped) appears and stays quiet while it lasts; a new alert is logged at error and
 * POSTed as JSON `{ stage, kind, text, at }` to ALERT_WEBHOOK_URL (when set). Read-only: nothing is signed or sent.
 */

export interface Alert {
  /** Stable while the condition lasts: `relayer.low:GBCA…`, `treasury.low`, `facilitator.down:www.x402.org`. */
  readonly kind: string
  /** One sentence a person reads: what crossed which floor. */
  readonly text: string
}

/** Floors per network (orchestrator, 25 Oct): testnet relayers 500 XLM and treasury 60 USDC; mainnet A 12, B 5 XLM. */
export interface Floors {
  readonly relayerXlm: ReadonlyArray<number>
  readonly treasuryUsdc: number
  readonly ttlDays: number
  readonly toolErrors: number
}

export const floorsFor = (network: 'testnet' | 'pubnet'): Floors =>
  network === 'pubnet'
    ? { relayerXlm: [12, 5], treasuryUsdc: 0, ttlDays: 7, toolErrors: 1 }
    : { relayerXlm: [500], treasuryUsdc: 60, ttlDays: 7, toolErrors: 1 }

export interface Readings {
  readonly network: 'testnet' | 'pubnet'
  readonly health: ChainHealth | null
  readonly paymentsEnabled: boolean
  readonly routers: ReadonlyArray<{ readonly name: string; readonly id: string; readonly daysLeft: number | null }>
  readonly toolErrors: number
}

const LEDGER_SECONDS = 5
const xlm = (stroops: bigint) => Number(stroops) / 1e7
const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return 'facilitator'
  }
}

/** The alerts these readings raise against these floors. Pure. */
export function evaluate(readings: Readings, floors: Floors): ReadonlyArray<Alert> {
  const net = readings.network === 'pubnet' ? 'mainnet' : 'testnet'
  const alerts: Array<Alert> = []
  const health = readings.health
  if (health === null) alerts.push({ kind: 'health.unreadable', text: `${net}: the chain health could not be read` })
  else {
    health.relayers.forEach((relayer, index) => {
      const floor = floors.relayerXlm[index] ?? floors.relayerXlm.at(-1) ?? 0
      const held = xlm(relayer.xlmStroops)
      if (held < floor)
        alerts.push({
          kind: `relayer.low:${short(relayer.address)}`,
          text: `${net} relayer ${short(relayer.address)} holds ${held.toFixed(1)} XLM (floor ${floor})`,
        })
    })
    if (health.treasury !== null && xlm(health.treasury.usdcStroops) < floors.treasuryUsdc)
      alerts.push({
        kind: 'treasury.low',
        text: `${net} treasury holds ${xlm(health.treasury.usdcStroops).toFixed(2)} USDC (floor ${floors.treasuryUsdc})`,
      })
    for (const facilitator of health.facilitators ?? [])
      if (!facilitator.ok)
        alerts.push({
          kind: `facilitator.down:${hostOf(facilitator.url)}`,
          text: `${net} facilitator ${hostOf(facilitator.url)} did not answer /supported`,
        })
  }
  if (!readings.paymentsEnabled)
    alerts.push({ kind: 'payments.disabled', text: `${net}: PAYMENTS_ENABLED is off, every payment is refused` })
  for (const router of readings.routers)
    if (router.daysLeft === null || router.daysLeft < floors.ttlDays)
      alerts.push({
        kind: `contract.ttl:${router.name}`,
        text:
          router.daysLeft === null
            ? `${net} ${router.name} ${short(router.id)} is not live (archived or missing)`
            : `${net} ${router.name} ${short(router.id)} lives ${router.daysLeft.toFixed(1)} more days (floor ${floors.ttlDays})`,
      })
  if (readings.toolErrors >= floors.toolErrors)
    alerts.push({
      kind: 'tools.unexpected_errors',
      text: `${net}: ${readings.toolErrors} unexpected tool error(s) in the last 10 minutes`,
    })
  return alerts
}

/** An alert's identity for dedupe: its kind with every number stripped. */
export const kindKey = (kind: string) => kind.replace(/\d+(\.\d+)?/gu, '#')

/** The kinds in `now` that were not open last run (`open`), and the set to remember for the next run. */
export function newAlerts(open: ReadonlyArray<string>, now: ReadonlyArray<Alert>) {
  const before = new Set(open)
  const keys = now.map(alert => kindKey(alert.kind))
  return { fresh: now.filter((_, index) => !before.has(keys[index] ?? '')), open: [...new Set(keys)] }
}

/** What the alerts need from the OAuth store Durable Object: the open kinds and the tool-error counter. */
export interface AlertStoreShape {
  /** Replaces the open kinds with `kinds` and returns the previous set. */
  readonly swapOpen: (kinds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>
  /** Counts one unexpected tool error now. Never fails. */
  readonly toolError: Effect.Effect<void>
  /** Unexpected tool errors since `sinceMs`. */
  readonly toolErrorsSince: (sinceMs: number) => Effect.Effect<number>
}

export class AlertStore extends Context.Service<AlertStore, AlertStoreShape>()('hm/AlertStore') {
  /** In memory (tests, local without the Durable Object). */
  static readonly memory = () => {
    const state = { open: [] as ReadonlyArray<string>, errors: [] as Array<number> }
    return Layer.succeed(AlertStore, {
      swapOpen: kinds =>
        Effect.sync(() => {
          const before = state.open
          state.open = [...kinds]
          return before
        }),
      toolError: Effect.flatMap(Clock.currentTimeMillis, now =>
        Effect.sync(() => {
          state.errors.push(now)
        }),
      ),
      toolErrorsSince: sinceMs => Effect.sync(() => state.errors.filter(at => at >= sinceMs).length),
    })
  }

  /** On a Worker: the OAuthStore Durable Object's `alerts` methods (kv-shim.ts). Failures read as nothing open. */
  static readonly fromStore = (store: {
    readonly alertsSwap: (kinds: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>
    readonly toolErrorBump: () => Promise<void>
    readonly toolErrorCount: (sinceMs: number) => Promise<number>
  }) =>
    Layer.succeed(AlertStore, {
      swapOpen: kinds =>
        Effect.tryPromise(() => store.alertsSwap(kinds)).pipe(
          Effect.catch(error => Effect.as(logFailure('warn', 'alerts.store_failed', error), [])),
        ),
      toolError: Effect.tryPromise(() => store.toolErrorBump()).pipe(
        Effect.catch(error => logFailure('warn', 'alerts.store_failed', error)),
      ),
      toolErrorsSince: sinceMs =>
        Effect.tryPromise(() => store.toolErrorCount(sinceMs)).pipe(
          Effect.catch(error => Effect.as(logFailure('warn', 'alerts.store_failed', error), 0)),
        ),
    })
}

/** Counts an unexpected tool error when the runtime has an AlertStore (the Worker's); a no-op otherwise. */
export const countToolError = Effect.flatMap(Effect.serviceOption(AlertStore), store =>
  Option.match(store, { onNone: () => Effect.void, onSome: s => s.toolError }),
)

/** What a run needs from the bindings: the stage, ALERT_WEBHOOK_URL (a secret), and floor overrides for a local run. */
export interface AlertParams {
  readonly stage: string
  readonly webhook: Option.Option<Redacted.Redacted>
  readonly treasuryFloor: Option.Option<number>
  readonly relayerFloor: Option.Option<number>
}

const numberOf = (text: string | undefined) =>
  text === undefined || text.trim() === '' || !Number.isFinite(Number(text)) ? Option.none() : Option.some(Number(text))

/** The params from the Worker's string bindings (STAGE, ALERT_WEBHOOK_URL, ALERT_*_FLOOR_* ). */
export const alertParams = (bindings: Readonly<Record<string, string | undefined>>): AlertParams => ({
  stage: bindings['STAGE'] ?? 'unknown',
  webhook:
    bindings['ALERT_WEBHOOK_URL'] === undefined || bindings['ALERT_WEBHOOK_URL'] === ''
      ? Option.none()
      : Option.some(Redacted.make(bindings['ALERT_WEBHOOK_URL'])),
  treasuryFloor: numberOf(bindings['ALERT_TREASURY_FLOOR_USDC']),
  relayerFloor: numberOf(bindings['ALERT_RELAYER_FLOOR_XLM']),
})

/** Reads the stage, evaluates it, remembers what is open, and reports what is new. Never fails. */
export const runAlerts = (config: AlertParams, post: (url: string, body: string) => Promise<Response>) =>
  Effect.gen(function* () {
    const network = yield* Network
    const chain = yield* Chain
    const store = yield* AlertStore
    const base = floorsFor(network.name)
    const floors: Floors = {
      ...base,
      treasuryUsdc: Option.getOrElse(config.treasuryFloor, () => base.treasuryUsdc),
      relayerXlm: Option.match(config.relayerFloor, { onNone: () => base.relayerXlm, onSome: floor => [floor] }),
    }
    const health = yield* chain.health.pipe(
      Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => Effect.succeed(null) }),
      Effect.catch(error => Effect.as(logFailure('warn', 'alerts.health_failed', error), null)),
    )
    const ops = yield* Effect.serviceOption(StellarOps)
    const routers = yield* Option.match(ops, {
      onNone: () => Effect.succeed([] as Readings['routers']),
      onSome: o => {
        const named = [
          { name: 'deposit_router', id: o.network.contracts.depositRouter },
          { name: 'onboard_router', id: o.network.contracts.onboardRouter },
        ].filter(router => router.id !== '')
        return o
          .ttlStatus(
            named.map(router => router.id),
            [],
          )
          .pipe(
            Effect.map(status =>
              named.map(router => {
                const entry = status.entries.find(e => e.target === router.id && e.kind === 'instance')
                const until = entry?.liveUntilLedger ?? null
                return {
                  ...router,
                  daysLeft: until === null ? null : ((until - status.latestLedger) * LEDGER_SECONDS) / 86_400,
                }
              }),
            ),
            Effect.catch(error => Effect.as(logFailure('warn', 'alerts.ttl_failed', error), [])),
          )
      },
    })
    const toolErrors = yield* store.toolErrorsSince((yield* Clock.currentTimeMillis) - 10 * 60_000)
    const alerts = evaluate(
      { network: network.name, health, paymentsEnabled: network.caps.paymentsEnabled, routers, toolErrors },
      floors,
    )
    const { fresh } = newAlerts(yield* store.swapOpen(newAlerts([], alerts).open), alerts)
    const at = DateTime.formatIso(yield* DateTime.now)
    for (const alert of fresh) {
      yield* Effect.logError('alert.new').pipe(annotate({ kind: kindKey(alert.kind) }))
      yield* Option.match(config.webhook, {
        onNone: () => Effect.logError('alert.webhook_missing').pipe(annotate({ kind: kindKey(alert.kind) })),
        onSome: url =>
          Effect.tryPromise(() =>
            post(Redacted.value(url), JSON.stringify({ stage: config.stage, kind: alert.kind, text: alert.text, at })),
          ).pipe(
            Effect.flatMap(response =>
              response.ok
                ? Effect.void
                : Effect.logError('alert.webhook_failed').pipe(annotate({ status_code: response.status })),
            ),
            Effect.catch(error => logFailure('error', 'alert.webhook_failed', error)),
          ),
      })
    }
    yield* Effect.logInfo('alerts.run').pipe(
      annotate({ count: alerts.length, outcome: fresh.length > 0 ? 'new' : 'known' }),
    )
    return { alerts, fresh }
  })

/** For the scheduled handler outside the runtime's logger (worker.ts): one line when the run itself throws. */
export const logScheduledFailure = (stage: string, error: unknown) =>
  logEvent({ app: 'nod', stage }, 'error', 'alerts.run_failed', {
    error_tag: typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : 'Error',
  })
