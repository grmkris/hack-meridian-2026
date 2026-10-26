import { DurableObject } from 'cloudflare:workers'

import { type Admission, admitCreation, type CreateLimits, parseLog } from './wallet-caps.ts'

/**
 * The subset of Workers KV that @cloudflare/workers-oauth-provider 1.2.4 calls (get text/json, put with
 * expiration/expirationTtl/metadata, delete, list by prefix with cursor), in one SQLite-backed Durable Object. Ported
 * from spikes/s4/src/kv-shim.ts. Why: the deploy token has no Workers KV permission; side benefit, reads are strongly
 * consistent where KV can serve a stale miss for up to 60 s.
 */
interface Row extends Record<string, SqlStorageValue> {
  k: string
  v: string
  exp: number | null
  meta: string | null
}

export class OAuthStore extends DurableObject<object> {
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER, meta TEXT)')
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS caps (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
  }

  /**
   * The wallet-creation caps (wallet-caps.ts): read the last hour's log, decide, and with `take` record the creation,
   * all in one turn, so two creations arriving together cannot both take the last slot. Not part of the KV shim.
   */
  walletCreation(visitor: string, limits: CreateLimits, take: boolean): Admission {
    const row = this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM caps WHERE k = ?', 'wallet-create').toArray()[0]
    const result = admitCreation(parseLog(row?.v), Date.now(), visitor, limits)
    if (take && result.admission.ok)
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO caps (k, v) VALUES (?, ?)',
        'wallet-create',
        JSON.stringify(result.log),
      )
    return result.admission
  }

  /**
   * The alerts' memory (alerts.ts): the kinds open since the last run, replaced with `kinds`; the previous set comes
   * back so the caller reports only the new ones. Not part of the KV shim.
   */
  alertsSwap(kinds: ReadonlyArray<string>): ReadonlyArray<string> {
    const row = this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM caps WHERE k = ?', 'alerts-open').toArray()[0]
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO caps (k, v) VALUES (?, ?)', 'alerts-open', JSON.stringify(kinds))
    const previous: unknown = row === undefined ? [] : JSON.parse(row.v)
    return Array.isArray(previous) ? previous.filter((kind): kind is string => typeof kind === 'string') : []
  }

  /** One unexpected tool error now (mcp-tools.ts); the log keeps the last hour. */
  toolErrorBump(): void {
    const now = Date.now()
    const kept = [...this.toolErrorLog().filter(at => at > now - 3_600_000), now]
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO caps (k, v) VALUES (?, ?)', 'tool-errors', JSON.stringify(kept))
  }

  /** Unexpected tool errors since `sinceMs` (the alerts' last-10-minutes count). */
  toolErrorCount(sinceMs: number): number {
    return this.toolErrorLog().filter(at => at >= sinceMs).length
  }

  private toolErrorLog(): Array<number> {
    const row = this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM caps WHERE k = ?', 'tool-errors').toArray()[0]
    const log: unknown = row === undefined ? [] : JSON.parse(row.v)
    return Array.isArray(log) ? log.filter((at): at is number => typeof at === 'number') : []
  }

  kvGet(key: string): string | null {
    const now = Math.floor(Date.now() / 1000)
    const rows = this.ctx.storage.sql
      .exec<Row>('SELECT k, v, exp FROM kv WHERE k = ? AND (exp IS NULL OR exp > ?)', key, now)
      .toArray()
    return rows[0]?.v ?? null
  }

  kvPut(key: string, value: string, exp: number | null, meta: string | null): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO kv (k, v, exp, meta) VALUES (?, ?, ?, ?)', key, value, exp, meta)
  }

  kvDelete(key: string): void {
    this.ctx.storage.sql.exec('DELETE FROM kv WHERE k = ?', key)
  }

  kvList(prefix: string, limit: number, cursor: string | undefined) {
    const now = Math.floor(Date.now() / 1000)
    const rows = this.ctx.storage.sql
      .exec<Row>(
        'SELECT k, v, exp, meta FROM kv WHERE k >= ? AND k < ? AND k > ? AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT ?',
        prefix,
        `${prefix}￿`,
        cursor ?? '',
        now,
        limit + 1,
      )
      .toArray()
    const page = rows.slice(0, limit)
    const complete = rows.length <= limit
    const last = page.at(-1)
    return {
      keys: page.map(r => ({
        name: r.k,
        ...(r.exp === null ? {} : { expiration: r.exp }),
        ...(r.meta === null ? {} : { metadata: JSON.parse(r.meta) as unknown }),
      })),
      list_complete: complete,
      ...(complete || last === undefined ? {} : { cursor: last.k }),
    }
  }
}

type GetOptions = 'text' | 'json' | { type?: 'text' | 'json'; cacheTtl?: number } | undefined
interface PutOptions {
  expiration?: number
  expirationTtl?: number
  metadata?: unknown
}

/** A KVNamespace look-alike over OAuthStore; the Worker passes it to the provider as env.OAUTH_KV. */
export function durableKv(ns: DurableObjectNamespace<OAuthStore>): KVNamespace {
  const stub = () => ns.getByName('oauth')
  const shim = {
    async get(key: string, options?: GetOptions) {
      const value = await stub().kvGet(key)
      if (value === null) return null
      const type = typeof options === 'string' ? options : options?.type
      if (type === undefined || type === 'text') return value
      if (type === 'json') return JSON.parse(value) as unknown
      throw new Error(`durableKv: unsupported get type ${String(type)}`)
    },
    async put(key: string, value: unknown, options?: PutOptions) {
      if (typeof value !== 'string') throw new Error('durableKv: only string values are supported')
      const exp =
        options?.expiration ??
        (options?.expirationTtl !== undefined ? Math.floor(Date.now() / 1000) + options.expirationTtl : null)
      await stub().kvPut(key, value, exp, options?.metadata === undefined ? null : JSON.stringify(options.metadata))
    },
    async delete(key: string) {
      await stub().kvDelete(key)
    },
    async list(options: { prefix?: string; limit?: number; cursor?: string | null } = {}) {
      return stub().kvList(options.prefix ?? '', Math.min(options.limit ?? 1000, 1000), options.cursor ?? undefined)
    },
  }
  // SAFETY: the shim implements exactly the KV calls workers-oauth-provider 1.2.4 makes (S4 audited its dist); any
  // other call is absent and fails loudly.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion
  return shim as unknown as KVNamespace
}
