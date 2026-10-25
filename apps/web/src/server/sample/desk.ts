import { SAMPLE_LIMITS, type SampleRun, type SampleSite, type StartReply } from './model.ts'

/**
 * The front desk of `/sample`, independent of where it is hosted (the SampleRunner Durable Object; a Map in tests):
 * admits at most one run at a time within the hourly and per-visitor limits, queues the run for the alarm, keeps each
 * run's log, and runs the queued run once. Nothing here touches the chain.
 */

export interface Gate {
  /** Start times (ms) within the last hour. */
  readonly starts: ReadonlyArray<number>
  /** Visitor (hashed cf-connecting-ip) → last start (ms), within the per-visitor window. */
  readonly visitors: Readonly<Record<string, number>>
  readonly current: { readonly id: string; readonly startedAt: number } | null
}

export const EMPTY_GATE: Gate = { starts: [], visitors: {}, current: null }

const HOUR_MS = 3_600_000
const minutes = (seconds: number) => {
  const m = Math.max(1, Math.ceil(seconds / 60))
  return `${m} minute${m === 1 ? '' : 's'}`
}

type Refusal = Extract<StartReply, { readonly ok: false }>

/** Admit a new run `id` for `visitor` at `now`, or say why not. A run older than `staleMs` no longer holds the lock. */
export const admit = (
  gate: Gate,
  now: number,
  visitor: string,
  id: string,
  limits: typeof SAMPLE_LIMITS = SAMPLE_LIMITS,
): { readonly ok: true; readonly gate: Gate } | Refusal => {
  const current = gate.current !== null && now - gate.current.startedAt < limits.staleMs ? gate.current : null
  if (current !== null)
    return {
      ok: false,
      reason: 'busy',
      message: 'A sample run is going right now. This page shows it; you can start your own when it finishes.',
      retry_after_s: Math.ceil((current.startedAt + limits.staleMs - now) / 1000),
      current: current.id,
    }
  const starts = gate.starts.filter(at => now - at < HOUR_MS)
  const oldest = starts[0]
  if (starts.length >= limits.perHour && oldest !== undefined) {
    const wait = Math.ceil((oldest + HOUR_MS - now) / 1000)
    return {
      ok: false,
      reason: 'hourly',
      message: `Nod allows ${limits.perHour} sample runs an hour (each one spends real testnet fees). The next one opens in ${minutes(wait)}.`,
      retry_after_s: wait,
      current: null,
    }
  }
  const last = gate.visitors[visitor]
  if (last !== undefined && now - last < limits.perVisitorMs) {
    const wait = Math.ceil((last + limits.perVisitorMs - now) / 1000)
    return {
      ok: false,
      reason: 'visitor',
      message: `One sample run per visitor every ${minutes(limits.perVisitorMs / 1000)}. Yours opens again in ${minutes(wait)}.`,
      retry_after_s: wait,
      current: null,
    }
  }
  const visitors = Object.fromEntries(Object.entries(gate.visitors).filter(([, at]) => now - at < limits.perVisitorMs))
  return {
    ok: true,
    gate: { starts: [...starts, now], visitors: { ...visitors, [visitor]: now }, current: { id, startedAt: now } },
  }
}

export const release = (gate: Gate, id: string): Gate => (gate.current?.id === id ? { ...gate, current: null } : gate)

/** What a queued run needs to execute (no secrets: the runner reads VAULT_KEY from its own bindings). */
export interface RunTicket {
  readonly id: string
  readonly site: SampleSite
}

/** The storage the desk runs on: Durable Object storage in the Worker, a Map in tests. */
export interface DeskStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (entries: Record<string, unknown>) => Promise<void>
  readonly delete: (keys: ReadonlyArray<string>) => Promise<void>
  /** Wake the host to run the queued run (the Durable Object's alarm). */
  readonly wake: () => Promise<void>
}

export type Execute = (ticket: RunTicket, report: (run: SampleRun) => Promise<void>) => Promise<SampleRun>

/** How many runs keep their log (older ones are deleted). */
const KEEP_RUNS = 30

const randomRunId = () =>
  `sr_${[...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('')}`

export class SampleDesk {
  constructor(
    private readonly storage: DeskStorage,
    private readonly now: () => number = Date.now,
    private readonly limits: typeof SAMPLE_LIMITS = SAMPLE_LIMITS,
  ) {}

  /** Admit and queue a run; the host's wake-up executes it. The read-modify-write is one Durable Object turn. */
  async start(visitor: string, site: SampleSite): Promise<StartReply> {
    const gate = (await this.storage.get<Gate>('gate')) ?? EMPTY_GATE
    const id = randomRunId()
    const now = this.now()
    const admission = admit(gate, now, visitor, id, this.limits)
    if (!admission.ok) return admission
    const run: SampleRun = {
      id,
      status: 'queued',
      created_at: new Date(now).toISOString(),
      finished_at: null,
      lines: [],
      error: null,
    }
    const ids = [...((await this.storage.get<ReadonlyArray<string>>('runs')) ?? []), id]
    const dropped = ids.slice(0, Math.max(0, ids.length - KEEP_RUNS))
    const ticket: RunTicket = { id, site }
    await this.storage.put({
      gate: admission.gate,
      runs: ids.slice(-KEEP_RUNS),
      [`run:${id}`]: run,
      [`ticket:${id}`]: ticket,
    })
    if (dropped.length > 0) await this.storage.delete(dropped.flatMap(old => [`run:${old}`, `ticket:${old}`]))
    await this.storage.wake()
    return { ok: true, id }
  }

  status(id: string): Promise<SampleRun | undefined> {
    return this.storage.get<SampleRun>(`run:${id}`)
  }

  /**
   * Execute the queued run, saving every update; never throws. A retried wake-up (the host died mid-run) does not run
   * again: payments are not replayed blindly, the run is marked interrupted and the lock is freed.
   */
  async runQueued(execute: Execute, retried: boolean): Promise<void> {
    const gate = (await this.storage.get<Gate>('gate')) ?? EMPTY_GATE
    const current = gate.current
    if (current === null) return
    const ticket = await this.storage.get<RunTicket>(`ticket:${current.id}`)
    const queued = await this.status(current.id)
    const finish = async (run: SampleRun) => {
      const latest = (await this.storage.get<Gate>('gate')) ?? EMPTY_GATE
      await this.storage.put({ [`run:${run.id}`]: run, gate: release(latest, run.id) })
    }
    /** The run as last saved, marked failed (its lines so far stay). */
    const failed = async (error: string): Promise<SampleRun> => {
      const latest = (await this.status(current.id)) ?? queued
      return {
        id: current.id,
        status: 'failed',
        created_at: latest?.created_at ?? new Date(current.startedAt).toISOString(),
        finished_at: new Date(this.now()).toISOString(),
        lines: latest?.lines ?? [],
        error,
      }
    }
    if (ticket === undefined || queued === undefined) return finish(await failed('the run was lost before it started'))
    if (retried || queued.status !== 'queued')
      return finish(await failed('the run was interrupted; nothing is repeated automatically. Start a new one.'))
    try {
      const report = (run: SampleRun) => this.storage.put({ [`run:${run.id}`]: run })
      await report({ ...queued, status: 'running' })
      return await finish(await execute(ticket, report))
    } catch (cause) {
      return finish(await failed(`the run stopped: ${cause instanceof Error ? cause.message : String(cause)}`))
    }
  }
}
