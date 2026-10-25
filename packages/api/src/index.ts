import { Schema } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, HttpApiSecurity } from 'effect/http-api'

import { Contact, ReceiptRecord } from '@hm/protocol'

/**
 * What the browser may ask of the Worker. The Worker implements it (apps/web/src/server) and the browser calls it
 * through the client derived from it (apps/web/src/api.ts), so a change here is checked on both sides. Browser-safe:
 * schemas only, no server code. Amounts are stroops as decimal strings, times ISO-8601 UTC, binary base64url.
 */

/** A Soroban contract address (strkey `C…`). */
export const ContractId = Schema.String.check(Schema.isPattern(/^C[A-Z2-7]{55}$/u))

/** The relayer pool and fee conditions, as the chain reports them (null when the chain did not answer). */
export const ChainStatus = Schema.Struct({
  /** `fixture` (in-memory), or the real chain's network. */
  mode: Schema.Literals(['fixture', 'testnet', 'pubnet']),
  /** CAIP-2 network and the explorer base links are built from. */
  network: Schema.Literals(['stellar:testnet', 'stellar:pubnet']),
  explorer_base: Schema.String,
  payments_enabled: Schema.Boolean,
  latest_ledger: Schema.Int,
  relayers: Schema.Array(Schema.Struct({ address: Schema.String, xlm: Schema.String })),
  treasury: Schema.NullOr(Schema.Struct({ address: Schema.String, usdc: Schema.String, xlm: Schema.String })),
  rent_factor: Schema.NullOr(Schema.Finite),
  /** The fee ceilings in force for a grant's first transfer and later ones (XLM), following the rent factor. */
  fee_ceilings: Schema.optionalKey(Schema.Struct({ first_xlm: Schema.Finite, later_xlm: Schema.Finite })),
  contracts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      id: Schema.String,
      live_until_ledger: Schema.NullOr(Schema.Int),
      ledgers_left: Schema.NullOr(Schema.Int),
    }),
  ),
})
export type ChainStatus = typeof ChainStatus.Type

export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  /** The Alchemy stage serving the request: `local` under `bun run dev`, `testnet` once deployed. */
  stage: Schema.String,
  /** The commit the stage was deployed from (`local` outside a deploy). */
  release: Schema.String,
  /** The Stellar network the Worker reads. */
  network: Schema.String,
  /** Relayer balances, rent factor and shared-contract TTLs; null when the chain did not answer in time. */
  chain: Schema.optional(Schema.NullOr(ChainStatus)),
  /**
   * Wallet creation needs an invite code (INVITE_REQUIRED; unset = on mainnet only). POST /api/wallets/options answers
   * 400 `invite_required` too.
   */
  invite_required: Schema.optionalKey(Schema.Boolean),
})
export type Health = typeof Health.Type

export const CounterReading = Schema.Struct({
  contractId: ContractId,
  network: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CounterReading = typeof CounterReading.Type

/** The stage has no counter contract configured. */
export class NotDeployed extends Schema.TaggedError<NotDeployed>()('NotDeployed', { error: Schema.String }) {}
/** Soroban RPC did not answer, or answered with something other than a count. */
export class ChainUnavailable extends Schema.TaggedError<ChainUnavailable>()('ChainUnavailable', {
  error: Schema.String,
}) {}

/** No owner session: sign in with the passkey. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', { error: Schema.String }) {}
/** The request was understood and refused (bad input, a passkey that does not verify, a used challenge). */
export class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', { error: Schema.String }) {}
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { error: Schema.String }) {}
/** The chain or storage failed; retry. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', { error: Schema.String }) {}

const Errors = [
  Unauthorized.pipe(HttpApiSchema.status(401)),
  BadRequest.pipe(HttpApiSchema.status(400)),
  NotFound.pipe(HttpApiSchema.status(404)),
  Unavailable.pipe(HttpApiSchema.status(503)),
]

/** The owner session: an HttpOnly, SameSite=Lax cookie (Secure on https) set after a passkey registration or assertion. */
export const OwnerSession = HttpApiSecurity.apiKey({ in: 'cookie', key: 'hm_owner' })

export const WalletSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contract_id: Schema.String,
  network: Schema.String,
  /** The relayer's deploy transaction and the welcome funding (testnet): proof links via `<explorer_base>/tx/<hash>`. */
  deploy_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fund_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type WalletSummary = typeof WalletSummary.Type
const WalletReply = Schema.Struct({ wallet: WalletSummary })

export const RegistrationOptions = Schema.Struct({
  challenge: Schema.String,
  rp_id: Schema.String,
  rp_name: Schema.String,
  user_id: Schema.String,
  user_name: Schema.String,
})
export const NewWallet = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  credential_id: Schema.String,
  /** 65-byte uncompressed P-256 key, or the SPKI `getPublicKey()` returns; base64url. */
  public_key: Schema.String,
  client_data_json: Schema.String,
  attestation_object: Schema.String,
  /** Required on mainnet. */
  invite_code: Schema.optionalKey(Schema.String),
})
export const AssertionOptions = Schema.Struct({
  challenge: Schema.String,
  rp_id: Schema.String,
  allow_credentials: Schema.Array(Schema.String),
})
export const Assertion = Schema.Struct({
  credential_id: Schema.String,
  client_data_json: Schema.String,
  authenticator_data: Schema.String,
  signature: Schema.String,
})

/** One connection and its spending grant. remaining = total − spent − reserved + pocket_balance. */
export const GrantView = Schema.Struct({
  connection_id: Schema.String,
  client_name: Schema.String,
  client_domain: Schema.NullOr(Schema.String),
  connection_status: Schema.Literals(['active', 'revoked']),
  grant_id: Schema.NullOr(Schema.String),
  total: Schema.String,
  spent: Schema.String,
  reserved: Schema.String,
  pocket_balance: Schema.String,
  remaining: Schema.String,
  valid_until: Schema.NullOr(Schema.String),
  /** The nod line, decimal USDC ("1.00"): inside the allowance, a payment at or above it needs the owner's nod. */
  nod_above_usdc: Schema.optionalKey(Schema.NullOr(Schema.String)),
  grant_status: Schema.NullOr(Schema.Literals(['active', 'revoked', 'expired'])),
  rule_status: Schema.NullOr(Schema.Literals(['installed', 'removal_pending', 'removed'])),
  rule_id: Schema.NullOr(Schema.Int),
  /** Proof links (tx hashes; build `<explorer_base>/tx/<hash>`): the allowance installed, removed, pocket swept. */
  install_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  remove_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sweep_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  revoked_at: Schema.NullOr(Schema.String),
})
export type GrantView = typeof GrantView.Type

export const PendingApproval = Schema.Struct({
  intent_id: Schema.String,
  requester: Schema.String,
  /** The agent's free-text reason: its claim, not a fact. */
  reason: Schema.NullOr(Schema.String),
  recipient_name: Schema.NullOr(Schema.String),
  recipient_address: Schema.String,
  amount: Schema.String,
  asset: Schema.String,
  expires_at: Schema.String,
  approve_url: Schema.String,
})
export type PendingApproval = typeof PendingApproval.Type

export const Overview = Schema.Struct({
  wallet: WalletSummary,
  /** The network the wallet lives on; show it everywhere. Always sent by the Worker. */
  network: Schema.optionalKey(Schema.Literals(['stellar:testnet', 'stellar:pubnet'])),
  /** e.g. https://stellar.expert/explorer/testnet: links are `<base>/tx/<hash>`. Always sent by the Worker. */
  explorer_base: Schema.optionalKey(Schema.String),
  /** The wallet's own balance, never the allowance. */
  balances: Schema.Struct({ usdc: Schema.String, xlm: Schema.String }),
  grants: Schema.Array(GrantView),
  pending: Schema.Array(PendingApproval),
  receipts: Schema.Array(ReceiptRecord),
})
export type Overview = typeof Overview.Type

export const RevokeReply = Schema.Struct({
  connection: GrantView,
  /** Where the owner's passkey removes the onchain rule; null when it is already gone. */
  approve_url: Schema.NullOr(Schema.String),
})

export const NewContact = Schema.Struct({
  display_name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  address: Schema.String,
  aliases: Schema.optional(Schema.Array(Schema.String)),
  memo: Schema.optional(Schema.String),
})
/** A new address for a saved contact: `confirm: true` is the owner's explicit confirmation on the site. */
export const ContactDestinationChange = Schema.Struct({
  address: Schema.String,
  memo: Schema.optional(Schema.String),
  confirm: Schema.Literal(true),
})

export { Contact, ReceiptRecord }

const IdParam = { id: Schema.String }

export class Api extends HttpApi.make('hack-meridian')
  .add(HttpApiGroup.make('system').add(HttpApiEndpoint.get('health', '/api/health', { success: Health })))
  .add(
    HttpApiGroup.make('counter').add(
      HttpApiEndpoint.get('read', '/api/counter', {
        success: CounterReading,
        error: [NotDeployed.pipe(HttpApiSchema.status(404)), ChainUnavailable.pipe(HttpApiSchema.status(503))],
      }),
    ),
  )
  .add(
    HttpApiGroup.make('session')
      .add(HttpApiEndpoint.get('current', '/api/session', { success: WalletReply, error: Errors }))
      .add(
        HttpApiEndpoint.post('registrationOptions', '/api/wallets/options', {
          /** `invite_code` is required on mainnet. */
          payload: Schema.Struct({ name: Schema.String, invite_code: Schema.optionalKey(Schema.String) }),
          success: RegistrationOptions,
          error: Errors,
        }),
      )
      .add(
        HttpApiEndpoint.post('createWallet', '/api/wallets', {
          payload: NewWallet,
          success: WalletReply,
          error: Errors,
        }),
      )
      .add(
        HttpApiEndpoint.post('assertionOptions', '/api/session/options', { success: AssertionOptions, error: Errors }),
      )
      .add(HttpApiEndpoint.post('signIn', '/api/session', { payload: Assertion, success: WalletReply, error: Errors }))
      .add(
        HttpApiEndpoint.post('signOut', '/api/session/sign-out', {
          success: HttpApiSchema.NoContent,
          error: Errors,
        }),
      ),
  )
  .add(
    HttpApiGroup.make('wallet')
      .add(HttpApiEndpoint.get('overview', '/api/overview', { success: Overview, error: Errors }))
      .add(HttpApiEndpoint.get('connections', '/api/connections', { success: Schema.Array(GrantView), error: Errors }))
      .add(
        HttpApiEndpoint.post('revokeConnection', '/api/connections/:id/revoke', {
          params: IdParam,
          success: RevokeReply,
          error: Errors,
        }),
      )
      .add(HttpApiEndpoint.get('contacts', '/api/contacts', { success: Schema.Array(Contact), error: Errors }))
      .add(
        HttpApiEndpoint.post('createContact', '/api/contacts', {
          payload: NewContact,
          success: Contact,
          error: Errors,
        }),
      )
      .add(
        HttpApiEndpoint.patch('changeContactDestination', '/api/contacts/:id', {
          params: IdParam,
          payload: ContactDestinationChange,
          success: Contact,
          error: Errors,
        }),
      )
      .add(HttpApiEndpoint.get('receipts', '/api/receipts', { success: Schema.Array(ReceiptRecord), error: Errors }))
      .add(HttpApiEndpoint.get('pending', '/api/pending', { success: Schema.Array(PendingApproval), error: Errors })),
  ) {}
