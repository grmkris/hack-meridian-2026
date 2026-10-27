import { describe, expect, test, vi } from 'vitest'

import type { OAuthResourceContext } from '@cloudflare/workers-oauth-provider'

import { serveMcpRequest } from './oauth.ts'
import { revokeConnection } from './revoke.ts'
import { sql, write } from './rows.ts'
import { CONNECTION, ORIGIN, WALLET, senderWorld } from './test/sender.ts'

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class extends Object {} }))

const resourceContext = (props: unknown, scope: Array<string>) => {
  // SAFETY: serveMcpRequest reads only props and auth; Workers lifecycle methods are not used by this seam test.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    props,
    auth: { token: 'provider-validated-token', audience: `${ORIGIN}/mcp`, scope },
  } as OAuthResourceContext<unknown>
}

const request = () =>
  new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

const expectInvalidToken = (response: Response) => {
  expect(response.status).toBe(401)
  expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"')
  expect(response.headers.get('www-authenticate')).toContain(
    `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  )
  expect(response.headers.get('cache-control')).toBe('no-store')
}

describe('MCP resource authorization', () => {
  test('a valid connection needs wallet scope, with a usable step-up challenge', async () => {
    const w = await senderWorld()
    const allowed = await serveMcpRequest(w.runtime, request(), resourceContext(w.ctx.props, ['wallet']))
    expect(allowed.status).toBe(200)
    const denied = await serveMcpRequest(w.runtime, request(), resourceContext(w.ctx.props, ['offline_access']))
    expect(denied.status).toBe(403)
    expect(denied.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect(denied.headers.get('www-authenticate')).toContain('scope="wallet"')
    expect(denied.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    )
  })

  test('revocation immediately denies the same token even when provider cleanup leaves it intact', async () => {
    // senderWorld uses OAuthGrants.none: provider-side deletion does not happen in this scenario.
    const w = await senderWorld()
    const context = resourceContext(w.ctx.props, ['wallet'])
    expect((await serveMcpRequest(w.runtime, request(), context)).status).toBe(200)
    await w.runtime.runPromise(revokeConnection(WALLET, w.contractId, CONNECTION))
    expectInvalidToken(await serveMcpRequest(w.runtime, request(), context))
    // A revoked connection never becomes a scope-escalation prompt.
    expectInvalidToken(await serveMcpRequest(w.runtime, request(), resourceContext(w.ctx.props, [])))
  })

  test('missing, mismatched and obsolete connection snapshots cannot discover tools', async () => {
    const w = await senderWorld()
    expect((await serveMcpRequest(w.runtime, request(), resourceContext(w.ctx.props, ['wallet']))).status).toBe(200)
    for (const props of [
      {},
      { ...w.ctx.props, owner_id: 'other-owner' },
      { ...w.ctx.props, wallet_id: 'other-wallet' },
    ])
      expectInvalidToken(await serveMcpRequest(w.runtime, request(), resourceContext(props, ['wallet'])))
    await w.runtime.runPromise(write(sql('DELETE FROM spending_grants WHERE connection_id = ?', CONNECTION)))
    await w.runtime.runPromise(write(sql('DELETE FROM connections WHERE id = ?', CONNECTION)))
    expectInvalidToken(await serveMcpRequest(w.runtime, request(), resourceContext(w.ctx.props, ['wallet'])))
  })
})
