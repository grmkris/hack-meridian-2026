import { describe, expect, it } from 'vitest'

import { canonicalRedirect } from './canonical.ts'

const ORIGIN = 'https://testnet.trynod.si'
const ALIAS = 'https://hack-meridian-testnet.kristjan-grm11775.workers.dev'

describe('canonicalRedirect', () => {
  it('sends every path on another host to ORIGIN with its query: 301 for GET, 308 for POST', () => {
    for (const path of [
      '/',
      '/mcp',
      '/.well-known/oauth-authorization-server',
      '/authorize?client_id=c&state=s',
      '/oauth/token',
      '/approve/pi_1',
      '/claim/pi_2',
      '/sample',
      '/api/wallet',
      '/assets/index.js',
    ]) {
      const moved = canonicalRedirect(new Request(`${ALIAS}${path}`), ORIGIN)
      expect(moved?.status).toBe(301)
      expect(moved?.headers.get('location')).toBe(`${ORIGIN}${path}`)
    }
    const post = canonicalRedirect(new Request(`${ALIAS}/mcp`, { method: 'POST', body: '{}' }), ORIGIN)
    expect(post?.status).toBe(308)
    expect(post?.headers.get('location')).toBe(`${ORIGIN}/mcp`)
    expect(
      canonicalRedirect(new Request('https://www.trynod.si/x?y=1'), 'https://trynod.si')?.headers.get('location'),
    ).toBe('https://trynod.si/x?y=1')
    expect(canonicalRedirect(new Request('http://testnet.trynod.si/'), ORIGIN)?.status).toBe(301)
  })

  it('leaves ORIGIN itself, GET /api/health on the alias and a stage without ORIGIN alone', () => {
    expect(canonicalRedirect(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' }), ORIGIN)).toBeUndefined()
    expect(canonicalRedirect(new Request(`${ALIAS}/api/health`), ORIGIN)).toBeUndefined()
    expect(canonicalRedirect(new Request(`${ALIAS}/api/health`, { method: 'POST' }), ORIGIN)?.status).toBe(308)
    expect(canonicalRedirect(new Request('http://localhost:18960/mcp'), undefined)).toBeUndefined()
    expect(canonicalRedirect(new Request('http://localhost:18960/mcp'), '')).toBeUndefined()
  })
})
