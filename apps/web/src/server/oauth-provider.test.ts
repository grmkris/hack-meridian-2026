import { Schema } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types'

import { providerOptions } from './oauth.ts'

// Only the Workers host class is replaced; registration, validation and storage use the real provider.
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class extends Object {} }))

const ORIGIN = 'https://wallet.test'
const Registration = Schema.Struct({
  client_id: Schema.String,
  grant_types: Schema.Array(Schema.String),
  redirect_uris: Schema.Array(Schema.String),
})

const provider = () => {
  const values = new Map<string, string>()
  // SAFETY: DCR uses only KV put; reads are supplied for the provider's client lookup.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const kv = {
    put: (key: string, value: string) => {
      values.set(key, value)
      return Promise.resolve()
    },
    get: (key: string, options?: { type?: string }) => {
      const value = values.get(key)
      return Promise.resolve(value === undefined ? null : options?.type === 'json' ? JSON.parse(value) : value)
    },
  } as unknown as KVNamespace
  const env = { OAUTH_KV: kv }
  const handler = { fetch: () => Promise.resolve(new Response(null, { status: 404 })) }
  const oauth = new OAuthProvider(providerOptions(ORIGIN, handler, handler))
  // SAFETY: DCR never uses the execution context; no resource handler is called in these tests.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const ctx = {} as ExecutionContext
  return {
    values,
    register: (metadata: Record<string, unknown>) =>
      oauth.fetch(
        new Request(`${ORIGIN}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'OAuth regression',
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'],
            ...metadata,
          }),
        }),
        env,
        ctx,
      ),
  }
}

describe('DCR capability negotiation through the installed OAuth provider', () => {
  test('registers and returns only supported grants for a VS Code-shaped client', async () => {
    const p = provider()
    const response = await p.register({
      grant_types: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
      ],
    })
    expect(response.status).toBe(201)
    const registered = Schema.decodeUnknownSync(Registration)(await response.json())
    expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(registered.redirect_uris).toEqual(['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'])
    expect(p.values.get(`client:${registered.client_id}`)).not.toContain('client_credentials')
    expect(p.values.get(`client:${registered.client_id}`)).toContain('authorization_code')
  })

  test('refuses an empty supported subset and inconsistent response types without storing a client', async () => {
    const p = provider()
    for (const metadata of [
      { grant_types: ['client_credentials'], response_types: [] },
      { grant_types: [] },
      { grant_types: ['authorization_code'], response_types: [] },
      { grant_types: ['authorization_code'], response_types: ['token'] },
      { grant_types: ['authorization_code', 1] },
    ]) {
      const response = await p.register(metadata)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' })
    }
    expect(p.values.size).toBe(0)
  })
})
