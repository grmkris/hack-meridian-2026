import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  ConnectionGrantCreateOutput,
  ConnectionGrantRevokeOutput,
  PaidOutcome,
  PaymentView,
  PocketPull,
  ReceiptView,
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
})
export type Shown = typeof Shown.Type

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
})
export type Model = typeof Model.Type
