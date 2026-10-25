import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

import type { OAuthStore } from './kv-shim.ts'
import type { Payments } from './payments.ts'

export interface Env {
  /** Set per request from OAUTH_STORE (kv-shim.ts); not a real KV binding. */
  OAUTH_KV: KVNamespace
  OAUTH_STORE: DurableObjectNamespace<OAuthStore>
  PAYMENTS: DurableObjectNamespace<Payments>
  /** Shared dev password standing in for the owner's sign-in (spike only; a Worker secret). */
  DEV_PASSWORD: string
  /** Injected by OAuthProvider into the default handler's env. */
  OAUTH_PROVIDER: OAuthHelpers
}

/** The spending grant the owner set on the consent page (in the product the passkey signs it onchain there). */
export interface GrantProps {
  grant_id: string
  asset: 'USDC'
  /** Total the connection may spend, decimal string, e.g. "5.00". */
  allowance: string
  valid_until: string
  /** Placeholder for the per-connection Ed25519 session key the service would generate and keep encrypted. */
  signer_key_id: string
}

/**
 * What completeAuthorization() stores (encrypted) on the OAuth grant; every MCP request sees it as ctx.props.
 * Survives token refresh; a new consent makes a new connection and grant.
 */
export interface ConnectionProps {
  owner_id: string
  wallet_id: string
  wallet_name: string
  /** One per OAuth grant: the product's `connection`. */
  connection_id: string
  client_id: string
  client_name: string
  granted_at: string
  grant: GrantProps
}
