/**
 * One identity per stage: when ORIGIN names the stage's public origin (testnet.trynod.si, trynod.si), a request on
 * any other host (the workers.dev alias, www, a version preview) or over http is sent there with its path and query.
 * Passkeys, the OAuth issuer and the resource metadata then only ever see ORIGIN. GET and HEAD get a 301; every other
 * method a 308, so a POST to /mcp or /api keeps its method and body. GET /api/health still answers on every host, so a
 * probe can read the release through the alias. No ORIGIN (the local stage), or the request is on it: undefined.
 */
export const canonicalRedirect = (request: Request, origin: string | undefined): Response | undefined => {
  if (origin === undefined || origin === '') return undefined
  const url = new URL(request.url)
  const canonical = new URL(origin)
  if (url.origin === canonical.origin) return undefined
  const safe = request.method === 'GET' || request.method === 'HEAD'
  if (safe && url.pathname === '/api/health') return undefined
  return Response.redirect(new URL(`${url.pathname}${url.search}`, canonical.origin).href, safe ? 301 : 308)
}
