import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  ConnectionGrantCreateOutput,
  ConnectionGrantRevokeOutput,
  PaidOutcome,
  PaymentView,
  PocketPull,
  ReceiptView,
  RequestView,
  TopupView,
  WalletOverviewOutput,
} from '@hm/protocol'

/**
 * The card's Model: which surface the server asked for, what the host offers, the tool call it renders and the
 * state of its polling. Everything the host sends arrives as unknown JSON and is decoded into these in `update`.
 */

/** `ui://nod/card/v1` renders one tool result inline; `ui://nod/home/v1` is the pinned, fullscreen wallet. */
export const Surface = Schema.Literals(['Card', 'Home'])
export type Surface = typeof Surface.Type

export const Theme = Schema.Literals(['Light', 'Dark'])
export type Theme = typeof Theme.Type

export const Capabilities = Schema.Struct({
  canCallTools: Schema.Boolean,
  canOpenLinks: Schema.Boolean,
  canShareContext: Schema.Boolean,
})
export type Capabilities = typeof Capabilities.Type

export const Bridge = defineTaggedUnion({
  Connecting: {},
  Connected: { capabilities: Capabilities },
  Unavailable: { reason: Schema.String },
})
export type Bridge = typeof Bridge.Type

/** The host's look: its theme, its CSS variables (mapped onto the card's tokens) and how the card is displayed. */
export const Appearance = Schema.Struct({
  maybeTheme: Schema.Option(Theme),
  variables: Schema.Record(Schema.String, Schema.String),
  isFullscreen: Schema.Boolean,
})
export type Appearance = typeof Appearance.Type

/** What the AI asked for, from the tool call's arguments: the seller, its own limit and its reason. */
export const ToolInput = Schema.Struct({
  maybeUrl: Schema.Option(Schema.String),
  maybeServerUrl: Schema.Option(Schema.String),
  maybeTool: Schema.Option(Schema.String),
  maybeMaxAmount: Schema.Option(Schema.String),
  maybeReason: Schema.Option(Schema.String),
  /** payment_prepare: the amount and who it is for, as the AI asked, before Nod answers. */
  maybeAmount: Schema.Option(Schema.String),
  maybeRecipient: Schema.Option(Schema.String),
})
export type ToolInput = typeof ToolInput.Type

/** One x402 purchase, from `paid_resource_fetch` or `paid_mcp_call`, in one shape. */
export const Purchase = Schema.Struct({
  kind: Schema.Literals(['Fetch', 'McpCall']),
  status: PaidOutcome,
  payment_id: Schema.NullOr(Schema.String),
  price: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(ReceiptView),
  approval_url: Schema.NullOr(Schema.String),
  message: Schema.String,
  pull: Schema.NullOr(PocketPull),
  facilitator_message: Schema.NullOr(Schema.String),
  grant_remaining: Schema.String,
  http_status: Schema.NullOr(Schema.Int),
  content_type: Schema.NullOr(Schema.String),
  maybePreview: Schema.Option(Schema.String),
})
export type Purchase = typeof Purchase.Type

export const Shown = defineTaggedUnion({
  Waiting: {},
  ToolFailed: { message: Schema.String },
  Unrecognised: {},
  Payment: { payment: PaymentView },
  Purchase: { purchase: Purchase, maybePayment: Schema.Option(PaymentView) },
  Wallet: { overview: WalletOverviewOutput },
  AllowanceLink: { link: ConnectionGrantCreateOutput },
  Revoked: { revoke: ConnectionGrantRevokeOutput },
  Request: { request: RequestView },
  Requests: { requests: Schema.Array(RequestView) },
  /** wallet_topup_quote / wallet_topup_status: a top-up from another chain (NEAR Intents). */
  Topup: { topup: TopupView },
})
export type Shown = typeof Shown.Type

/** A top-up from another chain as the card shows it. */
export type TopupCard = typeof TopupView.Type

/** Paying or declining a request from the card: confirmed first, with one idempotency key per action, kept for retries. */
export const RequestActionKind = Schema.Literals(['Pay', 'Decline'])
export type RequestActionKind = typeof RequestActionKind.Type

const ActionFields = { requestId: Schema.String, kind: RequestActionKind, key: Schema.String }

export const RequestAction = defineTaggedUnion({
  Idle: {},
  Confirming: ActionFields,
  Sending: ActionFields,
  Failed: { ...ActionFields, reason: Schema.String },
})
export type RequestAction = typeof RequestAction.Type

export const Poll = defineTaggedUnion({
  Idle: {},
  InFlight: {},
})
export type Poll = typeof Poll.Type

export const LinkState = defineTaggedUnion({
  Idle: {},
  Opening: { url: Schema.String },
  Failed: { url: Schema.String, reason: Schema.String },
})
export type LinkState = typeof LinkState.Type

/** Copying a claim link to send: the chat may block the clipboard, so a failure says how to copy it by hand. */
export const LinkCopy = defineTaggedUnion({
  Idle: {},
  Copied: {},
  Failed: {},
})
export type LinkCopy = typeof LinkCopy.Type

export const Model = Schema.Struct({
  surface: Surface,
  bridge: Bridge,
  /** The chat's own name for itself (ext-apps host info), when it is one a person would read. */
  maybeAppName: Schema.Option(Schema.String),
  appearance: Appearance,
  isVisible: Schema.Boolean,
  maybeToolName: Schema.Option(Schema.String),
  toolInput: ToolInput,
  shown: Shown,
  poll: Poll,
  pollCount: Schema.Int,
  maybePollError: Schema.Option(Schema.String),
  maybeSharedContext: Schema.Option(Schema.String),
  link: LinkState,
  linkCopy: LinkCopy,
  /** A payment the card itself prepared (paying a request); shown over everything else until settled or dismissed. */
  maybeActivePayment: Schema.Option(PaymentView),
  requestAction: RequestAction,
  maybeSelectedRequestId: Schema.Option(Schema.String),
  /** Home: requests waiting for this wallet to pay. */
  inbox: Schema.Array(RequestView),
})
export type Model = typeof Model.Type
