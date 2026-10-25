import { Effect, Schema } from 'effect'

import { toStroops } from '@hm/protocol'

import { McpEventError } from './errors.ts'
import type { EventDescriptor } from './schemas.ts'

/**
 * What a connection can subscribe to: six wallet-wide events, each delivered by webhook and by poll (Goblin subscribes
 * only to events that offer both). Every payload carries `title`, `summary`, `url` and `network`, written by Nod
 * (Goblin builds its notice from them), plus ids, amounts as decimal USDC strings and the counterparty as the owner
 * knows it. Never a third party's free text: no request notes, no AI-written reasons, no other owner's wallet name.
 */

export const EVENT_NAMES = [
  'payment.received',
  'payment.settled',
  'approval.needed',
  'request.received',
  'request.answered',
  'allowance.changed',
] as const
export type EventName = (typeof EVENT_NAMES)[number]

const DecimalUsdc = Schema.String.check(Schema.isPattern(/^\d{1,12}(?:\.\d{1,7})?$/u))
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

/** Each event's arguments, closed (an unknown key is invalid params). */
const ARGUMENTS = {
  'payment.received': Schema.Struct({ min_amount: Schema.optional(DecimalUsdc) }),
  'payment.settled': Schema.Struct({ payment_id: Schema.optional(Id) }),
  'approval.needed': Schema.Struct({}),
  'request.received': Schema.Struct({}),
  'request.answered': Schema.Struct({ request_id: Schema.optional(Id) }),
  'allowance.changed': Schema.Struct({}),
} as const

const object = (properties: Record<string, Schema.Json> = {}, required: ReadonlyArray<string> = []) => ({
  type: 'object',
  properties,
  ...(required.length === 0 ? {} : { required: [...required] }),
  additionalProperties: false,
})
const string = (description: string, extra: Record<string, Schema.Json> = {}) => ({
  type: 'string',
  description,
  ...extra,
})
const nullableString = (description: string) => ({ type: ['string', 'null'], description })
const amount = string('Decimal USDC, e.g. "2.50".', { pattern: '^\\d{1,12}(\\.\\d{1,7})?$' })

/** The fields every payload has: Nod's own words for a notice, and the network. */
const notice = {
  title: string('One line for a notice, at most 200 characters.'),
  summary: string('A sentence more, at most 1200 characters.'),
  url: string('Where the owner acts or reads more (http(s), at most 2048 characters).'),
  network: string('CAIP-2 network, e.g. "stellar:testnet".'),
  wallet_id: string('The Nod wallet the event is about.'),
}
const counterparty = {
  type: 'object',
  description: 'The other side: its Stellar address and the name the owner saved for it, if any.',
  properties: { address: string('Stellar address (C… or G…).'), contact_name: nullableString('Owner contact name.') },
  required: ['address', 'contact_name'],
  additionalProperties: false,
}
const NOTICE_REQUIRED = ['title', 'summary', 'url', 'network', 'wallet_id']

const descriptor = (
  name: EventName,
  title: string,
  description: string,
  inputSchema: Schema.JsonObject,
  payload: Record<string, Schema.Json>,
  required: ReadonlyArray<string>,
): EventDescriptor => ({
  name,
  title,
  description,
  inputSchema,
  payloadSchema: object({ ...notice, ...payload }, [...NOTICE_REQUIRED, ...required]),
  delivery: ['webhook', 'poll'],
})

export const EVENT_DESCRIPTORS: ReadonlyArray<EventDescriptor> = [
  descriptor(
    'payment.received',
    'Money received',
    'USDC arrived in the wallet: from anyone onchain, or from another Nod wallet. Optional min_amount skips smaller payments.',
    object({ min_amount: { ...amount, description: 'Only payments of at least this much USDC.' } }),
    {
      amount,
      asset: string('Always "USDC".'),
      counterparty,
      tx: string('Transaction hash.'),
      explorer: string('stellar.expert link to the transaction.'),
    },
    ['amount', 'asset', 'counterparty', 'tx', 'explorer'],
  ),
  descriptor(
    'payment.settled',
    'Payment settled',
    'A payment from the wallet reached its end: confirmed onchain, or failed. Optional payment_id follows one payment.',
    object({ payment_id: string('Only this payment (the payment_id payment_prepare returned).') }),
    {
      payment_id: string('The payment.'),
      status: { type: 'string', enum: ['confirmed', 'failed'] },
      amount,
      asset: string('Always "USDC".'),
      counterparty,
      tx: nullableString('Transaction hash, when confirmed.'),
      explorer: nullableString('stellar.expert link, when confirmed.'),
    },
    ['payment_id', 'status', 'amount', 'asset', 'counterparty', 'tx', 'explorer'],
  ),
  descriptor(
    'approval.needed',
    'Your nod is needed',
    "A payment is waiting for the owner's passkey: over the allowance, outside it, or rerouted. url is the approval page.",
    object(),
    {
      payment_id: string('The payment waiting.'),
      amount,
      asset: string('Always "USDC".'),
      counterparty,
      expires_at: string('When the request lapses (ISO-8601).'),
    },
    ['payment_id', 'amount', 'asset', 'counterparty', 'expires_at'],
  ),
  descriptor(
    'request.received',
    'Payment request received',
    "Someone asked this wallet for money. url is the request page; the requester's note is never in the payload.",
    object(),
    {
      request_id: string('The request.'),
      amount,
      asset: string('Always "USDC".'),
      counterparty,
      expires_at: string('When the request lapses (ISO-8601).'),
    },
    ['request_id', 'amount', 'asset', 'counterparty', 'expires_at'],
  ),
  descriptor(
    'request.answered',
    'Payment request answered',
    'A request this wallet sent was paid or declined. Optional request_id follows one request.',
    object({ request_id: string('Only this request.') }),
    {
      request_id: string('The request.'),
      status: { type: 'string', enum: ['paid', 'declined'] },
      amount,
      asset: string('Always "USDC".'),
      counterparty,
      tx: nullableString('Transaction hash, when paid.'),
      explorer: nullableString('stellar.expert link, when paid.'),
    },
    ['request_id', 'status', 'amount', 'asset', 'counterparty', 'tx', 'explorer'],
  ),
  descriptor(
    'allowance.changed',
    'Allowance changed',
    "An AI app's allowance on the wallet was installed or revoked, or has less than a fifth left.",
    object(),
    {
      connection_id: string('The connection whose allowance changed.'),
      change: { type: 'string', enum: ['installed', 'revoked', 'low'] },
      allowance: amount,
      remaining: amount,
      valid_until: string('When the allowance ends (ISO-8601).'),
    },
    ['connection_id', 'change', 'allowance', 'remaining', 'valid_until'],
  ),
]

export const isEventName = (name: string): name is EventName => EVENT_NAMES.some(known => known === name)

/** The descriptor of a known event, or not_found. */
export const eventDefinition = (name: string) =>
  isEventName(name)
    ? Effect.succeed(name)
    : Effect.fail(new McpEventError({ reason: 'not_found', data: { kind: 'event' } }))

/** Decode an event's arguments (closed); invalid params otherwise. */
export const eventArguments = (name: EventName, args: Schema.JsonObject) =>
  Schema.decodeUnknownEffect(ARGUMENTS[name])(args, { onExcessProperty: 'error' }).pipe(
    Effect.mapError(() => new McpEventError({ reason: 'invalid_params', data: { field: 'arguments' } })),
  )

const field = (data: Schema.JsonObject, key: string): Schema.Json | undefined => data[key]

/** Whether a journal row's payload passes a subscription's arguments (already decoded once at subscribe). */
export const matchesArguments = (name: string, args: Schema.JsonObject, data: Schema.JsonObject): boolean => {
  if (name === 'payment.received') {
    const min = field(args, 'min_amount')
    const value = field(data, 'amount')
    if (typeof min !== 'string') return true
    if (typeof value !== 'string') return false
    try {
      return toStroops(value) >= toStroops(min)
    } catch {
      return false
    }
  }
  if (name === 'payment.settled') {
    const id = field(args, 'payment_id')
    return typeof id !== 'string' || field(data, 'payment_id') === id
  }
  if (name === 'request.answered') {
    const id = field(args, 'request_id')
    return typeof id !== 'string' || field(data, 'request_id') === id
  }
  return true
}
