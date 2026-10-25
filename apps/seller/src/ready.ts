import type { x402ResourceServer } from '@x402/core/server'

const ready = new WeakSet<x402ResourceServer>()

/**
 * Fetches the facilitators' `/supported` once per isolate, inside the request that needs it. Workers cancel I/O when
 * the request that started it ends, so a promise kicked off by one request (what `paymentMiddleware`'s
 * `syncFacilitatorOnStart` does) can hang the next one; each request that finds the server cold initializes it itself.
 */
export async function ensureReady(rs: x402ResourceServer): Promise<void> {
  if (ready.has(rs)) return
  await rs.initialize()
  ready.add(rs)
}
