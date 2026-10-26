import { parseTraceparent, type Traceparent } from './traceparent.ts'

export { parseTraceparent } from './traceparent.ts'
export type { Traceparent } from './traceparent.ts'

/**
 * Per-request correlation (copied from ~/code/myapps/packages/observability/src/context.ts). `requestId` joins our
 * structured lines with Cloudflare's own invocation logs: the inbound `cf-ray` when it looks like an id, else a fresh
 * UUID. The Worker returns it as `x-nod-ref` and MCP results carry it in `_meta`, so a user can quote it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
/**
 * Receives one JSON line. Default: `console.log`, `console.warn` for `warn`, `console.error` for `error`, which
 * Workers Logs indexes (its level follows the console method).
 */
export type LogSink = (level: LogLevel, line: string) => void

export interface RequestContext {
  readonly requestId: string
  readonly traceparent?: Traceparent | undefined
  readonly startedAt: number
}

const consoleFor = (level: LogLevel) => {
  const { error, warn, log } = console
  if (level === 'error') return error
  if (level === 'warn') return warn
  return log
}

export const defaultSink: LogSink = (level, line) => {
  consoleFor(level).call(console, line)
}

/** A request id that can't carry log injection or unbounded input: printable id characters, at most 64. */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/u

const contexts = new WeakMap<Request, RequestContext>()

/**
 * The context for this request, memoised per `Request` object: the Worker's entry point creates it and the MCP lane
 * further down (workers-oauth-provider hands it the same object) gets the same id.
 */
export function requestContext(request: Request): RequestContext {
  const known = contexts.get(request)
  if (known !== undefined) return known
  const ray = request.headers.get('cf-ray')?.trim()
  const created: RequestContext = {
    requestId: ray !== undefined && SAFE_ID.test(ray) ? ray : crypto.randomUUID(),
    traceparent: parseTraceparent(request.headers.get('traceparent')),
    startedAt: Date.now(),
  }
  contexts.set(request, created)
  return created
}

/**
 * The route label for a path against known route prefixes (`/mcp`, `/api`): the longest prefix that matches whole
 * segments, else `unmatched`. It never carries part of the request path, so ids, claim links and typos stay out.
 */
export function routeLabel(pathname: string, routes: Iterable<string>): string {
  if (pathname === '/') return '/'
  let best: string | undefined
  for (const route of routes) {
    const hit = pathname === route || pathname.startsWith(route.endsWith('/') ? route : `${route}/`)
    if (hit && (best === undefined || route.length > best.length)) best = route
  }
  return best ?? 'unmatched'
}

/** Milliseconds since the request's context was created (the `duration_ms` of its `http.request` line). */
export const elapsedMs = (context: RequestContext) => Date.now() - context.startedAt
