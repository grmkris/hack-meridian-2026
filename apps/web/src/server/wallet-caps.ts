import { Config, Context, Effect, Layer, Option, Schema } from 'effect'

import { sha256Hex } from './clock.ts'
import { DbError } from './db.ts'

/**
 * How many wallets Nod creates in an hour: at most WALLET_CREATE_PER_VISITOR_HOUR (3) for one visitor (a hash of
 * cf-connecting-ip) and WALLET_CREATE_PER_HOUR (30) in all. Each wallet costs the relayer a deploy and, on testnet, the
 * treasury its welcome USDC, so this bounds what open signup can spend. POST /api/wallets/options checks (no slot
 * taken, the passkey prompt never opens when the answer is no); POST /api/wallets takes the slot right before the
 * deploy. The log lives in the OAuthStore Durable Object (one instance, so concurrent creations queue there).
 */

export interface CreateLimits {
  readonly perVisitorHour: number
  readonly perHour: number
}

export const DEFAULT_CREATE_LIMITS: CreateLimits = { perVisitorHour: 3, perHour: 30 }

/** Creations within the last hour, oldest first. */
export const CreationLog = Schema.Array(Schema.Struct({ at: Schema.Number, visitor: Schema.String }))
export type CreationLog = typeof CreationLog.Type

/** The stored log (JSON); unreadable or absent = empty. */
export const parseLog = (text: string | undefined): CreationLog =>
  text === undefined
    ? []
    : Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(CreationLog))(text), () => [])

export type Admission =
  | { readonly ok: true }
  | { readonly ok: false; readonly scope: 'visitor' | 'global'; readonly retryAfterS: number }

const HOUR_MS = 3_600_000

/** When `times` (oldest first, all within the hour) leaves room under `limit`, or undefined when it does now. */
const waitUnder = (times: ReadonlyArray<number>, limit: number, now: number): number | undefined => {
  if (times.length < limit) return undefined
  const frees = times[times.length - Math.max(limit, 1)]
  if (limit <= 0 || frees === undefined) return HOUR_MS / 1000
  return Math.max(1, Math.ceil((frees + HOUR_MS - now) / 1000))
}

/** May `visitor` create a wallet at `now`? `log` is what to store when the creation goes ahead. */
export const admitCreation = (
  log: CreationLog,
  now: number,
  visitor: string,
  limits: CreateLimits,
): { readonly admission: Admission; readonly log: CreationLog } => {
  const recent = log.filter(entry => now - entry.at < HOUR_MS && entry.at <= now)
  const visitorWait = waitUnder(
    recent.filter(entry => entry.visitor === visitor).map(entry => entry.at),
    limits.perVisitorHour,
    now,
  )
  const globalWait = waitUnder(
    recent.map(entry => entry.at),
    limits.perHour,
    now,
  )
  if (visitorWait === undefined && globalWait === undefined)
    return { admission: { ok: true }, log: [...recent, { at: now, visitor }] }
  const admission: Admission =
    (visitorWait ?? 0) >= (globalWait ?? 0)
      ? { ok: false, scope: 'visitor', retryAfterS: visitorWait ?? 0 }
      : { ok: false, scope: 'global', retryAfterS: globalWait ?? 0 }
  return { admission, log: recent }
}

/** The visitor a request counts against: a hash of its cf-connecting-ip, never the address itself. */
export const visitorOf = (ip: string | null | undefined) =>
  Effect.map(sha256Hex(`wallet|${ip ?? 'local'}`), hex => hex.slice(0, 32))

/** The wallet cap answered no; the API sends 429 `{ error: 'too_many_wallets', retry_after_s }`. */
export class WalletCapReached extends Schema.TaggedError<WalletCapReached>()('WalletCapReached', {
  scope: Schema.Literals(['visitor', 'global']),
  retryAfterS: Schema.Int,
}) {}

const refuse = (admission: Admission) =>
  admission.ok
    ? Effect.void
    : Effect.fail(new WalletCapReached({ scope: admission.scope, retryAfterS: admission.retryAfterS }))

export interface WalletCapsShape {
  readonly limits: CreateLimits
  /** Would a wallet for this visitor be admitted now? Takes no slot. */
  readonly check: (visitor: string) => Effect.Effect<void, WalletCapReached | DbError>
  /** Take a slot for this visitor, or fail with when one opens. */
  readonly take: (visitor: string) => Effect.Effect<void, WalletCapReached | DbError>
}

export const limitsConfig = Config.all({
  perVisitorHour: Config.Int('WALLET_CREATE_PER_VISITOR_HOUR').pipe(
    Config.withDefault(DEFAULT_CREATE_LIMITS.perVisitorHour),
  ),
  perHour: Config.Int('WALLET_CREATE_PER_HOUR').pipe(Config.withDefault(DEFAULT_CREATE_LIMITS.perHour)),
})

/** The caps over a log held in memory (tests, and any host without the Durable Object). */
export const memoryWalletCaps = (limits: CreateLimits, now: () => number = Date.now): WalletCapsShape => {
  const state = { log: [] as CreationLog }
  const ask = (visitor: string, take: boolean) =>
    Effect.suspend(() => {
      const result = admitCreation(state.log, now(), visitor, limits)
      if (take && result.admission.ok) state.log = result.log
      return refuse(result.admission)
    })
  return { limits, check: visitor => ask(visitor, false), take: visitor => ask(visitor, true) }
}

/** One call to the log's host: decide for `visitor`, and with `take` record the creation (OAuthStore.walletCreation). */
export type AskStore = (visitor: string, limits: CreateLimits, take: boolean) => Promise<Admission>

export class WalletCaps extends Context.Service<WalletCaps, WalletCapsShape>()('hm/WalletCaps') {
  /** On a Worker: the log in the OAuthStore Durable Object (runtime.ts), limits from the bindings' config. */
  static readonly fromStore = (askStore: AskStore) =>
    Layer.effect(
      WalletCaps,
      Effect.map(limitsConfig, (limits): WalletCapsShape => {
        const ask = (visitor: string, take: boolean) =>
          Effect.tryPromise({
            try: () => askStore(visitor, limits, take),
            catch: cause => new DbError({ operation: 'wallet caps', message: String(cause) }),
          }).pipe(Effect.flatMap(refuse))
        return { limits, check: visitor => ask(visitor, false), take: visitor => ask(visitor, true) }
      }),
    )

  static readonly memory = (limits: CreateLimits = DEFAULT_CREATE_LIMITS, now?: () => number) =>
    Layer.succeed(WalletCaps, memoryWalletCaps(limits, now))
}
