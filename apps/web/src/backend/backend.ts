import { Context, type Effect, type Option, Schema } from 'effect'

import type { Contact, GrantView, NewContact, Overview, ReceiptRecord, RevokeReply, WalletSummary } from './views'

/** The owner has no session on this device: sign in or create a wallet with a passkey. */
export class SignedOut extends Schema.TaggedError<SignedOut>()('SignedOut', {}) {}
/** The Worker refused or could not be reached; `error` is the sentence the page shows. */
export class BackendFailed extends Schema.TaggedError<BackendFailed>()('BackendFailed', { error: Schema.String }) {}
/** Creating a wallet on this network needs an invite code (mainnet while access is invite-only). */
export class InviteRequired extends Schema.TaggedError<InviteRequired>()('InviteRequired', {}) {}
export type BackendError = SignedOut | BackendFailed | InviteRequired

/** The WebAuthn ceremony inputs the Worker issues, and what the browser sends back after it. */
export interface RegistrationOptions {
  readonly challenge: string
  readonly rp_id: string
  readonly rp_name: string
  readonly user_id: string
  readonly user_name: string
}
export interface Registration {
  readonly name: string
  readonly credential_id: string
  readonly public_key: string
  readonly client_data_json: string
  readonly attestation_object: string
  readonly invite_code?: string
}
export interface AssertionOptions {
  readonly challenge: string
  readonly rp_id: string
  readonly allow_credentials: ReadonlyArray<string>
}
export interface Assertion {
  readonly credential_id: string
  readonly client_data_json: string
  readonly authenticator_data: string
  readonly signature: string
}

/** The Worker's /api as the site uses it. `layer` picks the HTTP or the fixture implementation (backend/index.ts). */
export class Backend extends Context.Service<
  Backend,
  {
    readonly session: Effect.Effect<WalletSummary, BackendError>
    readonly registrationOptions: (
      name: string,
      maybeInviteCode: Option.Option<string>,
    ) => Effect.Effect<RegistrationOptions, BackendError>
    readonly createWallet: (registration: Registration) => Effect.Effect<WalletSummary, BackendError>
    readonly assertionOptions: Effect.Effect<AssertionOptions, BackendError>
    readonly signIn: (assertion: Assertion) => Effect.Effect<WalletSummary, BackendError>
    readonly signOut: Effect.Effect<void, BackendError>
    readonly overview: Effect.Effect<Overview, BackendError>
    readonly connections: Effect.Effect<ReadonlyArray<GrantView>, BackendError>
    readonly revokeConnection: (connectionId: string) => Effect.Effect<RevokeReply, BackendError>
    readonly contacts: Effect.Effect<ReadonlyArray<Contact>, BackendError>
    readonly addContact: (contact: NewContact) => Effect.Effect<Contact, BackendError>
    readonly receipts: Effect.Effect<ReadonlyArray<ReceiptRecord>, BackendError>
  }
>()('hm/Backend') {}
