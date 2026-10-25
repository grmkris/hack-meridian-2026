#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { OAuthClientInformationMixed, OAuthTokens } from '../apps/seller/demo-deps.ts'
import { perform } from './demo/lib/actions.ts'
import { ownerBrowser } from './demo/lib/browser.ts'
import { ROOT } from './demo/lib/env.ts'
import { at, parseJson } from './demo/lib/json.ts'
import { connect, finishAuthorization, loopback, MemoryAuthProvider, startAuthorization } from './demo/lib/oauth.ts'
import { TARGETS } from './demo/targets.ts'

/**
 * A second AI app for end-to-end tests: its own passkey wallet (a virtual authenticator, as the rehearsal's), its own
 * OAuth connection, tokens kept in `.local/agents/` (mode 600, gitignored) so later calls reuse them.
 *
 *   bun scripts/agent.ts --target testnet --name bob connect
 *   bun scripts/agent.ts --target testnet --name bob call wallet_overview '{}'
 *   bun scripts/agent.ts --target testnet --name bob call request_create '{"payer":"C…","amount":"5","idempotency_key":"k1"}'
 *   bun scripts/agent.ts --target testnet --name bob rpc events/poll '{"name":"payment.received","arguments":{},"cursor":null}'
 *
 * The virtual passkey lives only while `connect` runs: this agent can ask for money and listen, not approve.
 */

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args.splice(index, 2)[1]
}
const target = TARGETS[flag('--target') ?? 'local']
const name = flag('--name') ?? 'bob'
if (target === undefined) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`)
const [command = 'call', ...rest] = args
const base = (process.env['HM_URL'] ?? target.base).replace(/\/$/u, '')
const mcpUrl = new URL(`${base}${target.mcpPath}`)
const dir = join(ROOT, '.local/agents')
const stateFile = join(dir, `${target.name}-${name}.json`)

interface State {
  readonly client: OAuthClientInformationMixed
  readonly tokens: OAuthTokens
  readonly wallet?: unknown
}

const save = (state: State) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  chmodSync(stateFile, 0o600)
}

const load = (): State => {
  if (!existsSync(stateFile)) throw new Error(`no ${stateFile}: run \`connect\` first`)
  const parsed = parseJson(readFileSync(stateFile, 'utf8'))
  // SAFETY: this script wrote the file with save(); a hand-edited file fails at the first call instead.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return parsed as State
}

const providerFrom = (state: State | undefined, redirect: string) => {
  const provider = new MemoryAuthProvider(redirect, `Nod agent (${name})`)
  if (state !== undefined) {
    provider.saveClientInformation(state.client)
    provider.saveTokens(state.tokens)
  }
  return provider
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))

const structuredOf = (result: unknown) => at(result, 'structuredContent') ?? result

if (command === 'connect') {
  const callback = loopback()
  const provider = providerFrom(undefined, callback.redirect)
  const authUrl = await startAuthorization(mcpUrl, provider, fetch)
  const evidence = join(dir, `${target.name}-${name}-consent`)
  mkdirSync(evidence, { recursive: true })
  const owner = await ownerBrowser(evidence)
  try {
    const redirected = callback.next()
    await perform(
      owner.page,
      target.consent,
      { auth_url: authUrl.href, base, allowance: target.allowance },
      shot => owner.shot(shot),
      line => console.error(`  ${line}`),
    )
    const params = await Promise.race([
      redirected,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no OAuth redirect within 180 s')), 180_000)),
    ])
    const code = params.get('code')
    if (code === null) throw new Error(`no code in the redirect: ${params.get('error') ?? '?'}`)
    await finishAuthorization(mcpUrl, provider, fetch, code)
  } finally {
    await owner.close()
    await callback.stop()
  }
  const client = await connect(mcpUrl, provider, fetch)
  const overview = structuredOf(await client.callTool({ name: 'wallet_overview', arguments: {} }))
  const tokens = provider.tokens()
  if (provider.client === undefined || tokens === undefined) throw new Error('no client or tokens after consent')
  save({ client: provider.client, tokens, wallet: at(overview, 'wallet') })
  print({
    agent: name,
    target: target.name,
    wallet: at(overview, 'wallet'),
    allowance: at(overview, 'grant_remaining'),
  })
  await client.close()
} else if (command === 'call') {
  const [tool, json = '{}'] = rest
  if (tool === undefined) throw new Error('call <tool> [json arguments]')
  const state = load()
  const provider = providerFrom(state, 'http://127.0.0.1/callback')
  const client = await connect(mcpUrl, provider, fetch)
  const result = await client.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, { timeout: 120_000 })
  const tokens = provider.tokens()
  if (tokens !== undefined) save({ ...state, tokens })
  print({ isError: at(result, 'isError') === true, text: at(result, 'content.0.text'), value: structuredOf(result) })
  await client.close()
} else if (command === 'rpc') {
  const [method, json = '{}'] = rest
  if (method === undefined) throw new Error('rpc <method> [json params]')
  // Refresh the token through the SDK first (a cheap read), then send the raw JSON-RPC message.
  const state = load()
  const provider = providerFrom(state, 'http://127.0.0.1/callback')
  const client = await connect(mcpUrl, provider, fetch)
  await client.close()
  const tokens = provider.tokens()
  if (tokens === undefined) throw new Error('no tokens')
  save({ ...state, tokens })
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: JSON.parse(json) }),
  })
  print({ status: response.status, body: parseJson(await response.text()) })
} else if (command === 'whoami') {
  print(load().wallet)
} else {
  throw new Error(`unknown command ${command}: connect | call | rpc | whoami`)
}
