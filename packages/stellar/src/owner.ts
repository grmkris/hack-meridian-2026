import { Effect } from 'effect'

import type { ChainError, PreparedOwnerAuth, WebAuthnAssertion } from '@hm/protocol'

/**
 * The one-shot form of an owner action (install grant, remove grant, owner transfer): prepare, let `sign` turn the
 * challenge into a passkey assertion, finalize. The Worker uses the split form (the page signs between two requests);
 * scripts and tests that hold a software passkey use this.
 *
 *   ownerOneShot(chain.prepareInstallGrant(c, k, n, s), ch => Effect.promise(() => passkey.assertChallenge(ch)), chain.installGrant)
 */
export const ownerOneShot = <A, E, R1, R2, R3>(
  prepare: Effect.Effect<PreparedOwnerAuth, ChainError, R1>,
  sign: (challenge: string) => Effect.Effect<WebAuthnAssertion, E, R2>,
  finalize: (prepared: PreparedOwnerAuth, assertion: WebAuthnAssertion) => Effect.Effect<A, ChainError, R3>,
): Effect.Effect<A, ChainError | E, R1 | R2 | R3> =>
  Effect.flatMap(prepare, prepared => Effect.flatMap(sign(prepared.challenge), a => finalize(prepared, a)))
