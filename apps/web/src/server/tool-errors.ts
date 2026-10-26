import { Effect, Schema } from 'effect'

/**
 * Every tool refusal names a code, what to do next (`recovery`) and how a retry goes (`retry`), so an AI app can act on
 * it without parsing prose. The wire shape is one JSON text block `{ error: { code, message, recovery, retry } }` with
 * `isError` and no structuredContent (mcp-tools.ts). The sentences of the ten codes in the bundled skill are the same
 * text (tool-errors.test.ts compares them with references/errors.md); a new code fails to typecheck until it has a
 * sentence and a retry here.
 */

export const ToolErrorCode = Schema.Literals([
  'ambiguous_recipient',
  'no_contact',
  'account_missing',
  'memo_unsupported',
  'payments_paused',
  'revoked',
  'no_allowance',
  'idempotency_conflict',
  'upstream_unavailable',
  'topup_unavailable',
  'invalid_input',
  'not_found',
])
export type ToolErrorCode = typeof ToolErrorCode.Type

/**
 * same-key: call again unchanged with the same idempotency key (later); new-key: a changed call, so a new key;
 * after-approval: once the user has acted (set an allowance, nodded); none: do not retry; read: read the state first.
 */
export const Retry = Schema.Literals(['same-key', 'new-key', 'after-approval', 'none', 'read'])
export type Retry = typeof Retry.Type

/** A contact the name could mean (ambiguous_recipient): the AI app shows these and asks which one. */
export const Candidate = Schema.Struct({ contact_id: Schema.String, name: Schema.String, address: Schema.String })
export type Candidate = typeof Candidate.Type

export class ToolError extends Schema.TaggedError<ToolError>()('ToolError', {
  code: ToolErrorCode,
  message: Schema.String,
  /** Overrides RECOVERY[code] when the refusal knows a better next step (e.g. the receipt no_contact points at). */
  recovery: Schema.optional(Schema.String),
  /** Overrides RETRY[code]. */
  retry: Schema.optional(Retry),
  candidates: Schema.optional(Schema.Array(Candidate)),
}) {}

export const RECOVERY: Readonly<Record<ToolErrorCode, string>> = {
  ambiguous_recipient:
    'Show the user the matches, with the name and the last characters of each address, and ask which one. Never pick one yourself.',
  no_contact:
    'Ask the user for the person\'s Stellar address. If the person has no wallet, prepare the payment with recipient "new" and recipient_name to get a claim link.',
  account_missing: 'Do not retry. Tell the user, and ask for another address or offer a claim link (recipient "new").',
  memo_unsupported:
    "Nod cannot pay addresses that need a memo yet. Ask the user for an address without a memo, such as their own wallet's.",
  payments_paused: 'Nothing was paid. Tell the user and try again later. Revoking still works.',
  revoked: 'Stop paying. If the user wants you to pay again, they reconnect Nod and set a new allowance.',
  no_allowance:
    "Offer the link from connection_grant_create so the user can set one. Until then, every payment needs the user's nod.",
  idempotency_conflict:
    'Retrying the same payment: send exactly the same arguments with the same key. A new payment: use a new key.',
  upstream_unavailable:
    'Do not assume it failed. If there is a payment_id, read payment_status first; then retry with the same key in a minute.',
  topup_unavailable:
    'Offer the deposit address (wallet_deposit_address) instead, or try the top-up again later on mainnet.',
  invalid_input: 'Correct what the message names, then call again with a new idempotency_key.',
  not_found:
    'Look the id up again (payments_list, requests_list or contacts_search) and call with one from the answer.',
}

export const RETRY: Readonly<Record<ToolErrorCode, Retry>> = {
  ambiguous_recipient: 'new-key',
  no_contact: 'new-key',
  account_missing: 'none',
  memo_unsupported: 'new-key',
  payments_paused: 'same-key',
  revoked: 'none',
  no_allowance: 'after-approval',
  idempotency_conflict: 'new-key',
  upstream_unavailable: 'same-key',
  topup_unavailable: 'none',
  invalid_input: 'new-key',
  not_found: 'read',
}

/** What the AI app reads in a refusal: `{ error: errorBody(error) }`. */
export const errorBody = (error: ToolError) => ({
  code: error.code,
  message: error.message,
  recovery: error.recovery ?? RECOVERY[error.code],
  retry: error.retry ?? RETRY[error.code],
  ...(error.candidates === undefined ? {} : { candidates: error.candidates }),
})

export interface RefusalExtra {
  readonly recovery?: string
  readonly retry?: Retry
  readonly candidates?: ReadonlyArray<Candidate>
}

export const toolError = (code: ToolErrorCode, message: string, extra: RefusalExtra = {}) =>
  new ToolError({ code, message, ...extra })

/** A refusal as an Effect failure. */
export const refuse = (code: ToolErrorCode, message: string, extra: RefusalExtra = {}) =>
  Effect.fail(toolError(code, message, extra))
