import { Predicate } from 'effect'
import { describe, expect, test } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { isModernRequest, type ModernDeps, protocolError, serveModern } from './mcp-modern.ts'

/**
 * The 2026-07-28 lane on fake deps: the wire rules (headers, versions, resultType, list caching) and the nod as a URL
 * elicitation. The same deps are real in mcp.test.ts.
 */

const ORIGIN = 'https://wallet.test'
const VERSION = '2026-07-28'
const APPROVE = `${ORIGIN}/approve/pi_1`
const OWNER_MESSAGE = 'Your AI app asks to pay 12 USDC to Jan on Stellar Testnet.'

const sentence = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

/** A payment that waits for the nod until `approve()` flips it to confirmed; `ownerMessage: false` drops approval_message. */
const world = (options: { readonly ownerMessage?: boolean } = {}) => {
  let approved = false
  const calls: Array<string> = []
  const deps: ModernDeps = {
    listTools: () => [{ name: 'payment_prepare', inputSchema: { type: 'object' } }],
    runTool: async name => {
      calls.push(name)
      const value = approved
        ? { payment_id: 'pi_1', status: 'confirmed', approval_url: null, receipt: { tx_hash: 'tx1' } }
        : {
            payment_id: 'pi_1',
            status: 'awaiting_approval',
            approval_url: APPROVE,
            ...(options.ownerMessage === false ? {} : { approval_message: OWNER_MESSAGE }),
            receipt: null,
          }
      return {
        result: { ...sentence(approved ? 'Paid.' : `Needs the nod: ${APPROVE}`), structuredContent: value },
        value,
      }
    },
    listResources: () => ({ resources: [{ uri: 'ui://nod/card/v1' }] }),
    readResource: async uri => {
      if (uri !== 'ui://nod/card/v1') throw protocolError(-32602, `Unknown resource ${uri}`)
      return { contents: [{ uri, text: '<html></html>' }] }
    },
    events: async method => {
      if (method === 'events/list') return { events: [] }
      throw protocolError(-32014, 'push delivery is not supported', { feature: 'deliveryMode', value: 'push' })
    },
    capabilities: { tools: {}, resources: {} },
    instructions: 'Nod.',
    serverInfo: { name: 'Nod', version: '0.1.0' },
  }
  return { deps, calls, approve: () => (approved = true) }
}

const meta = (capabilities: Record<string, unknown> = {}) => ({
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientCapabilities': capabilities,
})

const send = async (
  deps: ModernDeps,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  id: number | null = 1,
) => {
  const body = { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params: { ...params, _meta: meta() } }
  const request = new Request(`${ORIGIN}/mcp`, { method: 'POST', headers })
  const response = await serveModern(request, body, deps)
  const text = await response.text()
  const parsed: unknown = text === '' ? null : JSON.parse(text)
  return { status: response.status, json: Predicate.isObject(parsed) ? parsed : {} }
}

const resultOf = (json: Record<string, unknown>) => {
  const result = json['result']
  if (!Predicate.isObject(result)) throw new Error(`no result: ${JSON.stringify(json)}`)
  return result
}

const request = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/mcp`, { method: 'POST', headers })

describe('which requests take the 2026-07-28 lane', () => {
  test('server/discover, a _meta version or the version header', () => {
    expect(isModernRequest(request(), { jsonrpc: '2.0', id: 1, method: 'server/discover' })).toBe(true)
    expect(isModernRequest(request(), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } })).toBe(
      true,
    )
    expect(
      isModernRequest(request({ 'mcp-protocol-version': VERSION }), { jsonrpc: '2.0', method: 'notifications/x' }),
    ).toBe(true)
  })
  test('initialize-era requests and batches stay on the SDK lane', () => {
    expect(isModernRequest(request(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toBe(false)
    expect(isModernRequest(request({ 'mcp-protocol-version': '2025-11-25' }), { jsonrpc: '2.0', id: 1 })).toBe(false)
    expect(isModernRequest(request(), [{ jsonrpc: '2.0', id: 1, method: 'server/discover' }])).toBe(false)
  })
})

describe('the 2026-07-28 wire', () => {
  test('server/discover names the version, the capabilities, the server and is never cached', async () => {
    const { deps } = world()
    const result = resultOf((await send(deps, 'server/discover')).json)
    expect(result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [VERSION],
      capabilities: { tools: {}, resources: {} },
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Nod' } },
    })
  })

  test('lists carry ttlMs and cacheScope; reads carry resultType', async () => {
    const { deps } = world()
    expect(resultOf((await send(deps, 'tools/list')).json)).toMatchObject({ ttlMs: 0, resultType: 'complete' })
    expect(resultOf((await send(deps, 'resources/templates/list')).json)).toMatchObject({ resourceTemplates: [] })
    const read = await send(deps, 'resources/read', { uri: 'ui://nod/card/v1' })
    expect(resultOf(read.json)).toMatchObject({ resultType: 'complete', contents: [{ uri: 'ui://nod/card/v1' }] })
  })

  test('a header that disagrees with the body is -32020, an old version -32022', async () => {
    const { deps } = world()
    const mismatch = await send(deps, 'tools/list', {}, { 'mcp-method': 'tools/call' })
    expect(mismatch.status).toBe(400)
    expect(mismatch.json).toMatchObject({ error: { code: -32020 } })
    const old = await serveModern(
      request(),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': 'x' } },
      },
      deps,
    )
    expect(old.status).toBe(400)
    expect(await old.json()).toMatchObject({ error: { code: -32022, data: { supportedVersions: [VERSION] } } })
  })

  test('notifications get 202; unknown methods -32601; errors from deps keep their code and data', async () => {
    const { deps } = world()
    expect((await send(deps, 'notifications/initialized', {}, {}, null)).status).toBe(202)
    expect((await send(deps, 'prompts/list')).json).toMatchObject({ error: { code: -32601 } })
    expect((await send(deps, 'events/stream')).json).toMatchObject({
      error: { code: -32014, data: { feature: 'deliveryMode' } },
    })
    expect((await send(deps, 'resources/read', { uri: 'ui://nope' })).json).toMatchObject({ error: { code: -32602 } })
  })
})

const call = (deps: ModernDeps, extra: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}) =>
  serveModern(
    new Request(`${ORIGIN}/mcp`, { method: 'POST' }),
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'payment_prepare', arguments: { amount: '20' }, ...extra, _meta: meta(capabilities) },
    },
    deps,
  ).then(async response => {
    const parsed: unknown = await response.json()
    return resultOf(Predicate.isObject(parsed) ? parsed : {})
  })

describe('the nod as a URL elicitation (MRTR)', () => {
  const url = { elicitation: { url: {} } }

  test('a client without URL elicitation gets the plain result with the link', async () => {
    const { deps } = world()
    const result = await call(deps)
    expect(result['resultType']).toBe('complete')
    expect(result['structuredContent']).toMatchObject({ approval_url: APPROVE })
  })

  test('with URL elicitation: input_required, again while waiting, then the settled result on the retry', async () => {
    const { deps, approve, calls } = world()
    const first = await call(deps, {}, url)
    expect(first).toMatchObject({
      resultType: 'input_required',
      requestState: 'pi_1',
      inputRequests: {
        approval: { method: 'elicitation/create', params: { mode: 'url', url: APPROVE, message: OWNER_MESSAGE } },
      },
    })
    const retry = { requestState: 'pi_1', inputResponses: { approval: { action: 'accept' } } }
    expect((await call(deps, retry, url))['resultType']).toBe('input_required')
    approve()
    const settled = await call(deps, retry, url)
    expect(settled['resultType']).toBe('complete')
    expect(settled['structuredContent']).toMatchObject({ status: 'confirmed', receipt: { tx_hash: 'tx1' } })
    expect(calls).toEqual(['payment_prepare', 'payment_prepare', 'payment_prepare'])
  })

  test('the URL request shows the owner approval_message; a view without one falls back to the sentence', async () => {
    const without = await call(world({ ownerMessage: false }).deps, {}, url)
    expect(without).toMatchObject({
      inputRequests: { approval: { params: { mode: 'url', url: APPROVE, message: `Needs the nod: ${APPROVE}` } } },
    })
  })

  test('a declined or cancelled nod is the plain result (the card still waits), not an error; a foreign requestState is -32602', async () => {
    const { deps } = world()
    for (const action of ['decline', 'cancel']) {
      const answered = await call(deps, { requestState: 'pi_1', inputResponses: { approval: { action } } }, url)
      expect(answered['isError']).toBeUndefined()
      expect(answered['resultType']).toBe('complete')
      expect(answered['structuredContent']).toMatchObject({ status: 'awaiting_approval', approval_url: APPROVE })
    }
    const response = await serveModern(
      new Request(`${ORIGIN}/mcp`, { method: 'POST' }),
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'payment_prepare', arguments: {}, requestState: 'pi_other', _meta: meta(url) },
      },
      deps,
    )
    expect(await response.json()).toMatchObject({ error: { code: -32602 } })
  })
})
