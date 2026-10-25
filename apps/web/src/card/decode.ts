import { Array, Option, Predicate, Record, Schema, String } from 'effect'

import {
  ConnectionGrantCreateOutput,
  ConnectionGrantRevokeOutput,
  PaidMcpCallOutput,
  PaidResourceFetchOutput,
  PaymentView,
  RequestView,
  RequestsListOutput,
  TopupView,
  WalletOverviewOutput,
} from '@hm/protocol'

import { type ToolReply, toToolReply } from './host'
import { type Appearance, type Capabilities, type Purchase, Shown, type ToolInput, type TopupCard } from './model'

/** The host's JSON, decoded into the card's Model. Pure: `update` calls these on what the ports carried in. */

const field = (value: unknown, key: string): unknown => (Predicate.isObject(value) ? value[key] : undefined)

const stringField = (value: unknown, key: string): Option.Option<string> => {
  const found = field(value, key)
  return Predicate.isString(found) && String.isNonEmpty(found) ? Option.some(found) : Option.none()
}

export const decodeCapabilities = (capabilities: unknown): Capabilities => ({
  canCallTools: Predicate.isObject(field(capabilities, 'serverTools')),
  canOpenLinks: Predicate.isObject(field(capabilities, 'openLinks')),
  canShareContext: Predicate.isObject(field(capabilities, 'updateModelContext')),
})

/** The host CSS variables the card takes over, onto the card's own tokens. Brand colours and fonts stay Nod's. */
const HOST_VARIABLES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['--nod-paper', ['--color-background-primary']],
  ['--nod-wash', ['--color-background-secondary', '--color-background-tertiary']],
  ['--nod-ink', ['--color-text-primary']],
  ['--nod-muted', ['--color-text-secondary', '--color-text-tertiary']],
  ['--nod-line', ['--color-border-primary']],
]

const hostVariables = (context: unknown): Option.Option<Record<string, string>> => {
  const variables = field(field(context, 'styles'), 'variables')
  if (!Predicate.isObject(variables)) {
    return Option.none()
  }
  const valueOf = (name: string): Option.Option<string> =>
    Option.filter(Option.map(stringField(variables, name), String.trim), String.isNonEmpty)
  return Option.some(
    Record.fromEntries(
      Array.getSomes(
        Array.map(HOST_VARIABLES, ([token, names]) =>
          Option.map(Array.findFirst(names, valueOf), (value): readonly [string, string] => [token, value]),
        ),
      ),
    ),
  )
}

/** Fold a host context (whole at connect, partial on `host-context-changed`) into the appearance. */
export const mergeAppearance = (appearance: Appearance, context: unknown): Appearance => {
  const theme = field(context, 'theme')
  const displayMode = field(context, 'displayMode')
  return {
    maybeTheme:
      theme === 'dark' ? Option.some('Dark') : theme === 'light' ? Option.some('Light') : appearance.maybeTheme,
    variables: Option.getOrElse(hostVariables(context), () => appearance.variables),
    isFullscreen: Predicate.isString(displayMode) ? displayMode === 'fullscreen' : appearance.isFullscreen,
  }
}

/** A host name a person would read ("Claude", "ChatGPT"): its title, or a name that starts with a capital. */
export const appNameOf = (hostInfo: unknown): Option.Option<string> =>
  Option.orElse(stringField(hostInfo, 'title'), () =>
    Option.filter(stringField(hostInfo, 'name'), name => /^\p{Lu}[\p{L}\p{N} .-]{0,30}$/u.test(name)),
  )

/** The tool this card renders, when the host names it (`toolInfo.tool.name`). */
export const toolNameOf = (context: unknown): Option.Option<string> =>
  stringField(field(field(context, 'toolInfo'), 'tool'), 'name')

export const decodeToolInput = (params: unknown): ToolInput => {
  const args = field(params, 'arguments')
  return {
    maybeUrl: stringField(args, 'url'),
    maybeServerUrl: stringField(args, 'server_url'),
    maybeTool: stringField(args, 'tool'),
    maybeMaxAmount: stringField(args, 'max_amount'),
    maybeReason: stringField(args, 'reason'),
    maybeAmount: stringField(args, 'amount'),
    maybeRecipient: Option.orElse(stringField(args, 'recipient_name'), () => stringField(args, 'recipient')),
  }
}

const PREVIEW_CHARACTERS = 600

const preview = (text: string): Option.Option<string> => {
  const trimmed = String.trim(text)
  if (String.isEmpty(trimmed)) {
    return Option.none()
  }
  return Option.some(trimmed.length > PREVIEW_CHARACTERS ? `${trimmed.slice(0, PREVIEW_CHARACTERS)}…` : trimmed)
}

const jsonPreview = (value: unknown): Option.Option<string> => {
  if (value === undefined || value === null) {
    return Option.none()
  }
  if (Predicate.isString(value)) {
    return preview(value)
  }
  try {
    return preview(JSON.stringify(value, null, 2))
  } catch {
    return Option.none()
  }
}

const decodePayment = Schema.decodeUnknownOption(PaymentView)
const decodeTopup = Schema.decodeUnknownOption(TopupView)
const decodeWallet = Schema.decodeUnknownOption(WalletOverviewOutput)
const decodeFetch = Schema.decodeUnknownOption(PaidResourceFetchOutput)
const decodeMcpCall = Schema.decodeUnknownOption(PaidMcpCallOutput)
const decodeAllowanceLink = Schema.decodeUnknownOption(ConnectionGrantCreateOutput)
const decodeRevoke = Schema.decodeUnknownOption(ConnectionGrantRevokeOutput)
const decodeRequest = Schema.decodeUnknownOption(RequestView)
const decodeRequests = Schema.decodeUnknownOption(RequestsListOutput)

export const requestOf = (structured: unknown): Option.Option<RequestView> => decodeRequest(structured)

export const requestsOf = (structured: unknown): Option.Option<ReadonlyArray<RequestView>> =>
  Option.map(decodeRequests(structured), list => list.requests)

export const paymentOf = (structured: unknown): Option.Option<PaymentView> => decodePayment(structured)

export const topupOf = (structured: unknown): Option.Option<TopupCard> => decodeTopup(structured)

export const walletOf = (structured: unknown): Option.Option<WalletOverviewOutput> => decodeWallet(structured)

const asFetch = (structured: unknown): Option.Option<Purchase> =>
  Option.map(decodeFetch(structured), fetch => ({
    kind: 'Fetch',
    status: fetch.status,
    payment_id: fetch.payment_id,
    price: fetch.price,
    receipt: fetch.receipt,
    approval_url: fetch.approval_url,
    message: fetch.message,
    pull: fetch.pull ?? null,
    facilitator_message: fetch.facilitator_message ?? null,
    grant_remaining: fetch.grant_remaining,
    http_status: fetch.http_status,
    content_type: fetch.content_type,
    maybePreview: fetch.body === null ? Option.none() : preview(fetch.body),
  }))

const asMcpCall = (structured: unknown): Option.Option<Purchase> =>
  Option.map(decodeMcpCall(structured), call => ({
    kind: 'McpCall',
    status: call.status,
    payment_id: call.payment_id,
    price: call.price,
    receipt: call.receipt,
    approval_url: call.approval_url,
    message: call.message,
    pull: call.pull ?? null,
    facilitator_message: call.facilitator_message ?? null,
    grant_remaining: call.grant_remaining,
    http_status: null,
    content_type: null,
    maybePreview: jsonPreview(call.result),
  }))

type Decoder = (structured: unknown) => Option.Option<Shown>

const PAYMENT: Decoder = structured => Option.map(decodePayment(structured), payment => Shown.Payment({ payment }))
const TOPUP: Decoder = structured => Option.map(decodeTopup(structured), topup => Shown.Topup({ topup }))
const WALLET: Decoder = structured => Option.map(decodeWallet(structured), overview => Shown.Wallet({ overview }))
const FETCH: Decoder = structured =>
  Option.map(asFetch(structured), purchase => Shown.Purchase({ purchase, maybePayment: Option.none() }))
const MCP_CALL: Decoder = structured =>
  Option.map(asMcpCall(structured), purchase => Shown.Purchase({ purchase, maybePayment: Option.none() }))
const ALLOWANCE_LINK: Decoder = structured =>
  Option.map(decodeAllowanceLink(structured), link => Shown.AllowanceLink({ link }))
const REVOKED: Decoder = structured => Option.map(decodeRevoke(structured), revoke => Shown.Revoked({ revoke }))
const REQUEST: Decoder = structured => Option.map(decodeRequest(structured), request => Shown.Request({ request }))
const REQUESTS: Decoder = structured =>
  Option.map(decodeRequests(structured), list => Shown.Requests({ requests: list.requests }))

/** Shape order when the host does not name the tool: the most specific shapes first. */
const BY_SHAPE: ReadonlyArray<Decoder> = [
  PAYMENT,
  WALLET,
  REQUEST,
  REQUESTS,
  FETCH,
  MCP_CALL,
  REVOKED,
  ALLOWANCE_LINK,
  TOPUP,
]

const BY_TOOL: Readonly<Record<string, Decoder>> = {
  payment_prepare: PAYMENT,
  payment_status: PAYMENT,
  payment_execute: PAYMENT,
  wallet_overview: WALLET,
  nod_home: WALLET,
  paid_resource_fetch: FETCH,
  paid_mcp_call: MCP_CALL,
  connection_grant_create: ALLOWANCE_LINK,
  connection_grant_revoke: REVOKED,
  request_create: REQUEST,
  requests_list: REQUESTS,
  request_pay: PAYMENT,
  request_decline: REQUEST,
  wallet_topup_quote: TOPUP,
  wallet_topup_status: TOPUP,
}

/** What a tool result shows: the named tool's shape first, then any shape it fits. */
export const shownOf = (reply: ToolReply, maybeToolName: Option.Option<string>): Shown => {
  if (reply.isError) {
    return Shown.ToolFailed({ message: String.isNonEmpty(reply.text) ? reply.text : 'The tool call failed.' })
  }
  const named = Option.flatMap(maybeToolName, name => Option.fromNullishOr(BY_TOOL[name]))
  const decoders = Option.match(named, { onNone: () => BY_SHAPE, onSome: decoder => [decoder, ...BY_SHAPE] })
  return Option.getOrElse(
    Array.findFirst(decoders, decoder => decoder(reply.structured)),
    () => Shown.Unrecognised(),
  )
}

/** A `ui/notifications/tool-result` params object as what it shows. */
export const shownOfResult = (params: unknown, maybeToolName: Option.Option<string>): Shown =>
  shownOf(toToolReply(params), maybeToolName)
