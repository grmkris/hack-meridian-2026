import { Effect } from 'effect'

import { Chain } from '@hm/protocol'

import { Ledger } from './ledger.ts'
import { OAuthGrants } from './oauth-grants.ts'
import { connectionById, grantOfConnection } from './store.ts'

/**
 * Revoke, the service half (instant): the connection and its grant stop, every OAuth token of the connection dies,
 * the pocket's float is swept back to the smart account. The onchain rule removal needs the owner's passkey and
 * happens on /approve/revoke/<connection>; until then the rule is `removal_pending` and the service refuses to sign.
 */
export const revokeConnection = (walletId: string, contractId: string, connectionId: string) =>
  Effect.gen(function* () {
    const connection = yield* connectionById(connectionId)
    if (connection === undefined || connection.wallet_id !== walletId) return undefined
    const ledger = yield* Ledger
    yield* ledger.revokeConnection(walletId, { connectionId })
    yield* OAuthGrants.use(grants => grants.revokeConnection(connection.owner_id, connectionId)).pipe(
      Effect.catchTag('OAuthGrantError', error => Effect.logWarning('OAuth revokeGrant failed', error.message)),
    )
    const grant = yield* grantOfConnection(connectionId)
    if (grant !== undefined && grant.pocket_address !== null && grant.pocket_balance > 0n) {
      const chain = yield* Chain
      yield* chain.sweepPocket(grant.signer_key_ref, contractId).pipe(
        Effect.flatMap(receipt => ledger.recordSweep(walletId, { grantId: grant.id, receipt })),
        Effect.catchTag('ChainError', error => Effect.logWarning('pocket sweep failed', error.kind, error.message)),
      )
    }
    return { connection: yield* connectionById(connectionId), grant: yield* grantOfConnection(connectionId) }
  })
