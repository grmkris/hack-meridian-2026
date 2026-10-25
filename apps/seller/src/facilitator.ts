import { HTTPFacilitatorClient } from '@x402/core/server'
import type { FacilitatorClient } from '@x402/core/server'
import { SettleError, VerifyError } from '@x402/core/types'

import type { FacilitatorName, Settings } from './config.ts'

interface Named {
  readonly name: FacilitatorName
  readonly client: FacilitatorClient
}

const client = (f: Settings['facilitators'][number]): Named => {
  if (f.key === undefined) return { name: f.name, client: new HTTPFacilitatorClient({ url: f.url }) }
  const headers = { Authorization: `Bearer ${f.key}` }
  return {
    name: f.name,
    client: new HTTPFacilitatorClient({
      url: f.url,
      createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
    }),
  }
}

/**
 * Primary facilitator with a fallback. A structured answer (`VerifyError`, `SettleError`, `isValid: false`) is final;
 * only transport failures (timeouts, 5xx, unparseable bodies) move on to the next facilitator. A settle retried on the
 * fallback cannot pay twice: the payer's auth-entry nonce is consumed onchain by whichever settlement lands first.
 */
export class FallbackFacilitator implements FacilitatorClient {
  readonly #clients: ReadonlyArray<Named>

  constructor(settings: Settings) {
    this.#clients = settings.facilitators.map(client)
  }

  verify: FacilitatorClient['verify'] = (payload, requirements) =>
    this.#run('verify', c => c.verify(payload, requirements))

  settle: FacilitatorClient['settle'] = (payload, requirements) =>
    this.#run('settle', c => c.settle(payload, requirements))

  getSupported: FacilitatorClient['getSupported'] = () => this.#run('supported', c => c.getSupported())

  async #run<T>(label: string, call: (c: FacilitatorClient) => Promise<T>): Promise<T> {
    let failure: unknown = new Error('no facilitator configured')
    for (const { name, client: c } of this.#clients) {
      const started = Date.now()
      try {
        const result = await call(c)
        console.log(JSON.stringify({ facilitator: name, call: label, ms: Date.now() - started, ok: true }))
        return result
      } catch (error) {
        const final = error instanceof VerifyError || error instanceof SettleError
        console.log(
          JSON.stringify({
            facilitator: name,
            call: label,
            ms: Date.now() - started,
            ok: false,
            final,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          }),
        )
        if (final) throw error
        failure = error
      }
    }
    throw failure
  }
}
