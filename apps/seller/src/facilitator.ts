import { HTTPFacilitatorClient } from '@x402/core/server'
import type { FacilitatorClient } from '@x402/core/server'
import { SettleError, VerifyError } from '@x402/core/types'

import { FACILITATORS, type Env, type FacilitatorName } from './config.ts'

interface Named {
  readonly name: FacilitatorName
  readonly client: FacilitatorClient
}

const client = (name: FacilitatorName, env: Env): Named | undefined => {
  if (name === 'x402org') return { name, client: new HTTPFacilitatorClient({ url: FACILITATORS.x402org }) }
  const key = env.OZ_FACILITATOR_KEY
  if (key === undefined || key === '') return undefined
  const headers = { Authorization: `Bearer ${key}` }
  return {
    name,
    client: new HTTPFacilitatorClient({
      url: FACILITATORS.oz,
      createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
    }),
  }
}

/** The facilitators in the order this deployment tries them. */
export const facilitatorOrder = (env: Env): Array<FacilitatorName> =>
  (env.FACILITATOR === 'oz' ? (['oz', 'x402org'] as const) : (['x402org', 'oz'] as const)).filter(
    name => client(name, env) !== undefined,
  )

/**
 * Primary facilitator with a fallback. A structured answer (`VerifyError`, `SettleError`, `isValid: false`) is final;
 * only transport failures (timeouts, 5xx, unparseable bodies) move on to the next facilitator. A settle retried on the
 * fallback cannot pay twice: the payer's auth-entry nonce is consumed onchain by whichever settlement lands first.
 */
export class FallbackFacilitator implements FacilitatorClient {
  readonly #clients: ReadonlyArray<Named>

  constructor(env: Env) {
    this.#clients = facilitatorOrder(env).flatMap(name => client(name, env) ?? [])
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
