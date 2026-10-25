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
 * Primary facilitator with a fallback. A structured answer (`VerifyError`, `SettleError`, `isValid: false`) is final,
 * except a facilitator's own fee cap (`fee_exceeds_maximum`); transport failures (timeouts, 5xx, unparseable bodies)
 * and fee caps move on to the next facilitator. A settle retried on the
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
    for (const [index, { name, client: c }] of this.#clients.entries()) {
      const started = Date.now()
      try {
        const result = await call(c)
        // the verdict, not just the transport: isValid / invalidReason on verify, success / errorReason on settle
        const verdict = Object.fromEntries(
          Object.entries(typeof result === 'object' && result !== null ? result : {}).filter(([k]) =>
            ['isValid', 'invalidReason', 'invalidMessage', 'success', 'errorReason', 'transaction', 'payer'].includes(
              k,
            ),
          ),
        )
        console.log(JSON.stringify({ facilitator: name, call: label, ms: Date.now() - started, ok: true, ...verdict }))
        // A facilitator's own fee ceiling is not a verdict on the payment: x402.org refuses testnet payments once rent
        // pushes the simulated fee past its cap (fee_exceeds_maximum, seen at rent factor ~219 on 2026-10-25), while
        // OpenZeppelin Channels still settles them. Nothing was submitted, so the next facilitator may try.
        const why = verdict['invalidReason'] ?? verdict['errorReason']
        const reason = typeof why === 'string' ? why : ''
        if (reason.includes('fee_exceeds_maximum') && index < this.#clients.length - 1) {
          failure = new Error(`${name}: ${reason}`)
          continue
        }
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
