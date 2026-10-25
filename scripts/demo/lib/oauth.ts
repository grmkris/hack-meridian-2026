import {
  McpClient,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '../../../apps/seller/demo-deps.ts'

/**
 * A headless MCP OAuth client in the shape of docs/spikes/s4 `client/e2e.ts`: DCR with a loopback redirect, PKCE, the
 * consent page driven by the caller's browser, tokens in memory. The MCP SDK does discovery, DCR and the token
 * exchange; this file only stores what it hands over and catches the redirect.
 */
export class MemoryAuthProvider implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined
  #tokens: OAuthTokens | undefined
  #verifier: string | undefined
  #state: string | undefined
  authorizationUrl: URL | undefined

  constructor(
    readonly redirectUrl: string,
    readonly clientName: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'wallet offline_access',
    }
  }
  get expectedState() {
    return this.#state
  }
  state() {
    this.#state = crypto.randomUUID()
    return this.#state
  }
  clientInformation() {
    return this.client
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.client = info
  }
  tokens() {
    return this.#tokens
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier
  }
  codeVerifier() {
    if (this.#verifier === undefined) throw new Error('no PKCE verifier saved')
    return this.#verifier
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') this.client = undefined
    if (scope === 'all' || scope === 'client' || scope === 'tokens') this.#tokens = undefined
    if (scope === 'all' || scope === 'verifier') this.#verifier = undefined
  }
}

const unset = (_: URLSearchParams) => undefined

/** Loopback listener for the OAuth redirect (`http://127.0.0.1:<port>/callback`). */
export function loopback() {
  let resolve: (params: URLSearchParams) => void = unset
  let next = new Promise<URLSearchParams>(r => (resolve = r))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })
      resolve(url.searchParams)
      return new Response('<!doctype html><p>Signed in. You can close this tab.</p>', {
        headers: { 'content-type': 'text/html' },
      })
    },
  })
  return {
    redirect: `http://127.0.0.1:${server.port}/callback`,
    /** The next callback's query parameters. */
    next: () => next,
    reset: () => {
      next = new Promise<URLSearchParams>(r => (resolve = r))
    },
    stop: () => server.stop(true),
  }
}

/** Every request the MCP SDK makes, with tokens and codes redacted, for run.json. */
export interface WireEntry {
  readonly t: number
  readonly method: string
  readonly url: string
  readonly status: number
  readonly rpc?: string
}
const redact = (url: string) =>
  url.replace(/([?&](code|code_challenge|state|refresh_token|access_token)=)[^&]+/gu, '$1<redacted>')

export function recordingFetch(wire: Array<WireEntry>, started: number): typeof fetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    let rpc: string | undefined
    if (typeof init?.body === 'string') {
      const method = /"method"\s*:\s*"([^"]+)"/u.exec(init.body)?.[1]
      const tool = /"name"\s*:\s*"([^"]+)"/u.exec(init.body)?.[1]
      rpc = method === 'tools/call' && tool !== undefined ? `tools/call ${tool}` : method
    }
    const response = await fetch(request)
    wire.push({
      t: Math.round(performance.now() - started),
      method: request.method,
      url: redact(request.url),
      status: response.status,
      ...(rpc !== undefined ? { rpc } : {}),
    })
    return response
  }
  return Object.assign(wrapped, { preconnect: fetch.preconnect })
}

/** First connect: discovery + DCR, then the SDK asks for authorization (UnauthorizedError) with a URL. */
export async function startAuthorization(mcpUrl: URL, provider: MemoryAuthProvider, fetchFn: typeof fetch) {
  const client = new McpClient({ name: 'hm26-rehearse', version: '0.1.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider, fetch: fetchFn }))
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error
  }
  if (provider.authorizationUrl === undefined) throw new Error('the server did not ask for authorization')
  return provider.authorizationUrl
}

export async function finishAuthorization(
  mcpUrl: URL,
  provider: MemoryAuthProvider,
  fetchFn: typeof fetch,
  code: string,
) {
  await new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider, fetch: fetchFn }).finishAuth(code)
}

export async function connect(mcpUrl: URL, provider: MemoryAuthProvider, fetchFn: typeof fetch) {
  const client = new McpClient({ name: 'hm26-rehearse', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider, fetch: fetchFn }))
  return client
}
