import { Predicate } from 'effect'
import { describe, expect, test } from 'vitest'

import { callTool } from './mcp-tools.ts'
import { serveMcp } from './mcp.ts'
import manifest from './skill-manifest.json'
import { SKILL_URI, skillRoute, skillText } from './skill.ts'
import { senderWorld } from './test/sender.ts'

/**
 * Nod's bundled skill over MCP (the skills extension on both lanes, skills/list and skills/get, the files as resources,
 * get_guide) and on the site (/SKILL.md, /skill/nod-guide/…). What is served hashes to the build-time manifest.
 */

const AUTH = { token: 'token', clientId: 'https://claude.ai/oauth/claude-code-client-metadata', scopes: ['wallet'] }
const MODERN = '2026-07-28'
const INITIALIZE = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }

type World = Awaited<ReturnType<typeof senderWorld>>

const rpc = async (w: World, method: string, params: Record<string, unknown>, modern = false) => {
  const response = await serveMcp(
    w.runtime,
    new Request('https://wallet.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method,
        params: modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } : params,
      }),
    }),
    w.ctx,
    AUTH,
  )
  const json: unknown = await response.json()
  if (!Predicate.isObject(json)) throw new Error('not JSON')
  return json
}

const resultOf = (json: Record<string, unknown>) => {
  const result = json['result']
  if (!Predicate.isObject(result)) throw new Error(JSON.stringify(json))
  return result
}

const sha256 = async (text: string) => {
  const bytes = new TextEncoder().encode(text)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return {
    digest: `sha256:${[...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')}`,
    size: bytes.byteLength,
  }
}

const ENTRY = {
  uri: SKILL_URI,
  frontmatter: { name: 'nod-guide', description: expect.stringContaining("the user's Nod wallet") },
  resources: manifest,
}

describe('the skills extension', () => {
  test('both lanes declare it beside the events extension', async () => {
    const w = await senderWorld()
    const legacy = resultOf(await rpc(w, 'initialize', INITIALIZE))
    expect(legacy['capabilities']).toMatchObject({
      extensions: { 'io.modelcontextprotocol/skills': {}, 'io.modelcontextprotocol/events': {} },
    })
    const modern = resultOf(await rpc(w, 'server/discover', {}, true))
    expect(modern['capabilities']).toMatchObject({ extensions: { 'io.modelcontextprotocol/skills': {} } })
  })

  test('skills/list and skills/get answer the same on both lanes; an unknown URI is -32602', async () => {
    const w = await senderWorld()
    for (const modern of [false, true]) {
      expect(resultOf(await rpc(w, 'skills/list', {}, modern))).toEqual({
        resultType: 'complete',
        skills: [ENTRY],
        ttlMs: 300_000,
        cacheScope: 'public',
      })
      expect(resultOf(await rpc(w, 'skills/get', { uri: SKILL_URI }, modern))).toMatchObject({
        resultType: 'complete',
        skill: ENTRY,
      })
      expect(await rpc(w, 'skills/get', { uri: 'skill://other/SKILL.md' }, modern)).toMatchObject({
        id: 7,
        error: { code: -32602 },
      })
    }
  })

  test('the files are in resources/list as text/markdown, and resources/read serves what the manifest hashed', async () => {
    const w = await senderWorld()
    const listed = resultOf(await rpc(w, 'resources/list', {}))['resources']
    const skillFiles = (Array.isArray(listed) ? listed : [])
      .filter(Predicate.isObject)
      .filter(resource => String(resource['uri']).startsWith('skill://'))
    expect(skillFiles.map(resource => [resource['uri'], resource['mimeType']])).toEqual(
      expect.arrayContaining(manifest.map(entry => [entry.uri, 'text/markdown'])),
    )
    expect(skillFiles).toHaveLength(manifest.length)
    for (const entry of manifest) {
      const contents = resultOf(await rpc(w, 'resources/read', { uri: entry.uri }))['contents']
      const first: unknown = Array.isArray(contents) ? contents[0] : undefined
      const text = Predicate.isObject(first) ? String(first['text']) : ''
      expect(await sha256(text)).toEqual({ digest: entry.digest, size: entry.size })
    }
  })

  test('get_guide returns SKILL.md as its text and the entry as its value', async () => {
    const w = await senderWorld()
    const result = await callTool(w.runtime, w.ctx, 'get_guide', {})
    expect(result.content[0]).toEqual({ type: 'text', text: skillText })
    expect(result.structuredContent).toMatchObject({
      uri: SKILL_URI,
      name: 'nod-guide',
      references: [
        'skill://nod-guide/references/tools.md',
        'skill://nod-guide/references/errors.md',
        'skill://nod-guide/references/examples.md',
      ],
    })
  })
})

const get = (path: string, method = 'GET') => skillRoute(new Request(`https://trynod.si${path}`, { method }), path)

describe('the skill on the site', () => {
  test('/SKILL.md and /skill redirect (301) to /skill/nod-guide/SKILL.md', () => {
    for (const path of ['/SKILL.md', '/skill', '/skill/']) {
      const moved = get(path)
      expect(moved?.status).toBe(301)
      expect(moved?.headers.get('location')).toBe('https://trynod.si/skill/nod-guide/SKILL.md')
    }
  })

  test('the files are text/markdown with CORS *; other paths and methods fall through', async () => {
    const served = get('/skill/nod-guide/references/errors.md')
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(served?.headers.get('access-control-allow-origin')).toBe('*')
    const errors = manifest.find(entry => entry.uri.endsWith('errors.md'))
    expect(await sha256((await served?.text()) ?? '')).toEqual({ digest: errors?.digest, size: errors?.size })
    expect(get('/skill/nod-guide/nope.md')).toBeUndefined()
    expect(get('/SKILL.md', 'POST')).toBeUndefined()
  })
})
