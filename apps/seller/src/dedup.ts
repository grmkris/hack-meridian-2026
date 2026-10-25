import type { MiddlewareHandler } from 'hono'

import { decodePaymentSignatureHeader } from '@x402/core/http'
import { extractPaymentIdentifier } from '@x402/extensions/payment-identifier'

import { fingerprint, type AppEnv } from './config.ts'

/**
 * Runs before `paymentMiddleware`. Reads the payment id from the `PAYMENT-SIGNATURE` header; a settled id replays its
 * stored 200 + `PAYMENT-RESPONSE` (header `x-payment-cache: hit`) without verify or settle. Requests without an id
 * pass straight through to the x402 middleware.
 */
export const paymentIdDedup: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('paymentId', null)
  const header = c.req.header('payment-signature') ?? c.req.header('x-payment')
  if (header === undefined) return next()
  let id: string | null
  let fp: string
  try {
    const payload = decodePaymentSignatureHeader(header)
    id = extractPaymentIdentifier(payload)
    const a = payload.accepted
    fp = fingerprint([a.scheme, a.network, a.asset, a.amount, a.payTo, c.req.method, c.req.path])
  } catch {
    return next() // a malformed header gets the x402 middleware's own error
  }
  if (id === null) return next()
  c.set('paymentId', id)
  const ids = c.env.PAYMENT_IDS.get(c.env.PAYMENT_IDS.idFromName(id))
  const claim = await ids.claim(fp)
  if (claim.kind === 'conflict') return c.json({ error: 'payment_identifier_conflict', payment_id: id }, 409)
  if (claim.kind === 'pending')
    return c.json({ error: 'payment_in_progress', payment_id: id }, 409, { 'retry-after': '5' })
  if (claim.kind === 'hit') {
    const headers = new Headers(claim.response.headers)
    headers.set('x-payment-cache', 'hit')
    return new Response(claim.response.body, { status: claim.response.status, headers })
  }
  try {
    await next()
  } catch (error) {
    await ids.release(fp)
    throw error
  }
  if (c.res.status === 200 && c.res.headers.get('payment-response') !== null) {
    const body = await c.res.clone().text()
    await ids.complete(fp, { status: 200, body, headers: Object.fromEntries(c.res.headers.entries()) })
    c.res.headers.set('x-payment-cache', 'stored')
  } else {
    await ids.release(fp)
  }
}
