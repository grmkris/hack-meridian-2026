import { Schema } from 'effect'

/**
 * What completeAuthorization stores (encrypted) on the OAuth grant; every /mcp call sees it as ctx.props. A snapshot
 * from consent time: mutable grant state (spent, reserved, revoked) lives in D1 under grant_id. Never key on
 * client_id: CIMD ids are shared by every user of that client.
 */
export const ConnectionProps = Schema.Struct({
  owner_id: Schema.String,
  wallet_id: Schema.String,
  connection_id: Schema.String,
  client_id: Schema.String,
  client_name: Schema.String,
  client_domain: Schema.NullOr(Schema.String),
  granted_at: Schema.String,
  grant: Schema.Struct({
    grant_id: Schema.String,
    /** Decimal USDC, e.g. "5.00". */
    allowance: Schema.String,
    valid_until: Schema.String,
    rule_id: Schema.Int,
    signer_public_key: Schema.String,
  }),
})
export type ConnectionProps = typeof ConnectionProps.Type

/** The plaintext, listable metadata on the OAuth grant: enough to find and revoke a connection. */
export interface ConnectionMetadata {
  readonly connection_id: string
  readonly client_name: string
  readonly grant_id: string
  readonly allowance: string
  readonly valid_until: string
}
