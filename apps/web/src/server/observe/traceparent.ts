/** W3C correlation parser shared by Workers and daemons, without an Effect runtime. */
export interface Traceparent {
  readonly traceId: string
  readonly parentId: string
  readonly sampled: boolean
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** Parse a W3C `traceparent` header; `undefined` when absent or malformed (all-zero ids are malformed). */
export function parseTraceparent(header: string | null | undefined): Traceparent | undefined {
  const m = TRACEPARENT.exec((header ?? '').trim().toLowerCase())
  if (m === null || m[1] === 'ff') return undefined
  const traceId = m[2]
  const parentId = m[3]
  const flags = m[4]
  if (traceId === undefined || parentId === undefined || flags === undefined) return undefined
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return undefined
  return { traceId, parentId, sampled: (Number.parseInt(flags, 16) & 1) === 1 }
}
