import { DurableObject } from 'cloudflare:workers'

import type { GrantHelpers } from '../oauth-grants.ts'
import { type AppRuntime, makeRuntime, realChain, type WorkerEnv } from '../runtime.ts'
import { SampleDesk } from './desk.ts'
import type { SampleSite, StartReply, SampleRun } from './model.ts'
import { executeSample } from './run.ts'

/** The bindings the sample needs beyond the service's own (apps/web/alchemy.run.ts). */
export interface SampleEnv extends WorkerEnv {
  readonly VAULT_KEY?: string
  /** `false` switches /sample off; unset = on (the page exists on testnet only either way). */
  readonly SAMPLE_ENABLED?: string
  readonly SAMPLE_RUNNER?: DurableObjectNamespace<SampleRunner>
}

/** The sample agent is a connection without an OAuth grant: there is nothing to revoke at the provider. */
const NO_OAUTH: GrantHelpers = {
  listUserGrants: () => Promise.resolve({ items: [] }),
  revokeGrant: () => Promise.resolve(),
}

/** On the fixture chain (tests, `CHAIN=fixture` stages) nothing of value is sealed; the real chain needs VAULT_KEY. */
const FIXTURE_SECRET = 'fixture-stage sample key, not a secret'

export const sampleSecret = (env: SampleEnv): string | undefined =>
  env.VAULT_KEY !== undefined && env.VAULT_KEY !== '' ? env.VAULT_KEY : realChain(env) ? undefined : FIXTURE_SECRET

/**
 * One instance (`SAMPLE_RUNNER.getByName('sample')`) holds the /sample lock, the rate limits and every run's log in
 * its storage, and executes a run in its alarm (up to 15 minutes of wall clock, where a request would be cut off). The
 * run itself uses the service's runtime, built from the same bindings as the Worker's.
 */
export class SampleRunner extends DurableObject<SampleEnv> {
  private runtime: AppRuntime | undefined
  private readonly desk = new SampleDesk({
    // Each key holds one shape, so the port is generic exactly as Durable Object storage's own `get` is.
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
    get: <T>(key: string) => this.ctx.storage.get<T>(key),
    put: entries => this.ctx.storage.put(entries),
    delete: async keys => {
      await this.ctx.storage.delete([...keys])
    },
    wake: () => this.ctx.storage.setAlarm(Date.now()),
  })

  start(visitor: string, site: SampleSite): Promise<StartReply> {
    return this.desk.start(visitor, site)
  }

  status(id: string): Promise<SampleRun | undefined> {
    return this.desk.status(id)
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.desk.runQueued(
      (ticket, report) => {
        const secret = sampleSecret(this.env)
        if (secret === undefined) return Promise.reject(new Error('VAULT_KEY is not set on this stage'))
        this.runtime ??= makeRuntime(this.env, NO_OAUTH)
        return executeSample(this.runtime, { id: ticket.id, site: ticket.site, secret }, report)
      },
      (info?.retryCount ?? 0) > 0,
    )
  }
}
