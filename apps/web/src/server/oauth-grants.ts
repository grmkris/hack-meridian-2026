import { Context, Effect, Layer, Schema } from 'effect'

/**
 * The OAuth side of a revoke: find the provider grant that carries a connection (its metadata names the connection id)
 * and revoke it, which kills every access and refresh token of that connection at once (S4, demo step 9).
 */
export class OAuthGrantError extends Schema.TaggedError<OAuthGrantError>()('OAuthGrantError', {
  message: Schema.String,
}) {}

export interface GrantHelpers {
  readonly listUserGrants: (
    userId: string,
    options?: { cursor?: string },
  ) => Promise<{ items: ReadonlyArray<{ id: string; metadata?: unknown }>; cursor?: string }>
  readonly revokeGrant: (grantId: string, userId: string) => Promise<void>
}

export class OAuthGrants extends Context.Service<
  OAuthGrants,
  { readonly revokeConnection: (ownerId: string, connectionId: string) => Effect.Effect<boolean, OAuthGrantError> }
>()('hm/OAuthGrants') {
  static readonly fromHelpers = (helpers: GrantHelpers) =>
    Layer.succeed(OAuthGrants, {
      revokeConnection: (ownerId, connectionId) =>
        Effect.tryPromise({
          try: async () => {
            let cursor: string | undefined
            let revoked = false
            do {
              const page = await helpers.listUserGrants(ownerId, cursor === undefined ? {} : { cursor })
              for (const grant of page.items) {
                const meta = grant.metadata
                if (
                  typeof meta === 'object' &&
                  meta !== null &&
                  'connection_id' in meta &&
                  meta.connection_id === connectionId
                ) {
                  await helpers.revokeGrant(grant.id, ownerId)
                  revoked = true
                }
              }
              cursor = page.cursor
            } while (cursor !== undefined)
            return revoked
          },
          catch: cause => new OAuthGrantError({ message: String(cause) }),
        }),
    })

  /** Tests and the fixture stage: nothing to revoke. */
  static readonly none = Layer.succeed(OAuthGrants, { revokeConnection: () => Effect.succeed(false) })
}
