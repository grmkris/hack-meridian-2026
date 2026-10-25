/**
 * Hosted facilitators (copied from spikes/s2/lib/facilitators.ts) with call counters, so a seller can prove that a
 * refused purchase never reached the facilitator: `facilitatorStats` counts every verify / settle / supported call.
 *   hosted → https://www.x402.org/facilitator               (no key)
 *   oz     → https://channels.openzeppelin.com/x402/testnet (Bearer key, OZ_CHANNELS_API_KEY in spikes/s5/.env)
 */
import type { FacilitatorClient } from '@x402/core/server'
import { HTTPFacilitatorClient } from '@x402/core/server'

import { HOSTED_FACILITATOR, OZ_FACILITATOR, ozKey } from './env'

export type FacilitatorName = 'hosted' | 'oz'
export const facilitatorStats = { verify: 0, settle: 0, settleSuccess: 0, supported: 0, lastSettleMs: 0, lastVerifyMs: 0 }

export function facilitatorClient(name: FacilitatorName): FacilitatorClient {
  const inner =
    name === 'oz'
      ? new HTTPFacilitatorClient({
          url: OZ_FACILITATOR,
          createAuthHeaders: async () => {
            const h = { Authorization: `Bearer ${ozKey()}` }
            return { verify: h, settle: h, supported: h }
          },
        })
      : new HTTPFacilitatorClient({ url: HOSTED_FACILITATOR })
  const t = async <T>(label: 'verify' | 'settle' | 'supported', p: () => Promise<T>): Promise<T> => {
    facilitatorStats[label]++
    const t0 = performance.now()
    try {
      const r = await p()
      const dt = Math.round(performance.now() - t0)
      if (label === 'settle') {
        facilitatorStats.lastSettleMs = dt
        if ((r as { success?: boolean }).success) facilitatorStats.settleSuccess++
      }
      if (label === 'verify') facilitatorStats.lastVerifyMs = dt
      console.log(`[facilitator:${name}] ${label} #${facilitatorStats[label]} ${dt} ms ${JSON.stringify(r).slice(0, 300)}`)
      return r
    } catch (e) {
      console.log(`[facilitator:${name}] ${label} THREW after ${Math.round(performance.now() - t0)} ms: ${(e as Error).message}`)
      throw e
    }
  }
  return {
    verify: (p, r) => t('verify', () => inner.verify(p, r)),
    settle: (p, r) => t('settle', () => inner.settle(p, r)),
    getSupported: () => t('supported', () => inner.getSupported()),
  } as FacilitatorClient
}

export const facilitatorFromEnv = (fallback: FacilitatorName): FacilitatorName =>
  process.env.FACILITATOR === 'oz' ? 'oz' : process.env.FACILITATOR === 'hosted' ? 'hosted' : fallback
