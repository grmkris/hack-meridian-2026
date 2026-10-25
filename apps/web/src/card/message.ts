import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { ToolReply } from './host'
import { RequestActionKind } from './model'

export const Message = defineMessageUnion({
  ConnectedToHost: { capabilities: Schema.Unknown, context: Schema.Unknown, hostInfo: Schema.Unknown },
  FailedToConnect: { reason: Schema.String },
  ReceivedHostContext: { context: Schema.Unknown },
  ReceivedToolInput: { params: Schema.Unknown },
  ReceivedToolResult: { params: Schema.Unknown },
  ReceivedToolCancelled: {},
  ChangedVisibility: { isVisible: Schema.Boolean },
  TickedPoll: {},
  SucceededPollPayment: { reply: ToolReply },
  FailedPollPayment: { reason: Schema.String },
  SucceededPollWallet: { reply: ToolReply },
  FailedPollWallet: { reason: Schema.String },
  ClickedOpenLink: { url: Schema.String },
  SucceededOpenLink: {},
  FailedOpenLink: { url: Schema.String, reason: Schema.String },
  CompletedShareContext: {},
  SucceededPollInbox: { reply: ToolReply },
  FailedPollInbox: { reason: Schema.String },
  ClickedReviewRequest: { requestId: Schema.String },
  ClickedAllRequests: {},
  ClickedRequestAction: { requestId: Schema.String, kind: RequestActionKind },
  CompletedMakeActionKey: { requestId: Schema.String, kind: RequestActionKind, key: Schema.String },
  ClickedConfirmRequestAction: {},
  ClickedCancelRequestAction: {},
  SucceededRequestAction: { kind: RequestActionKind, reply: ToolReply },
  FailedRequestAction: { reason: Schema.String },
  ClickedClosePayment: {},
  ClickedCopyLink: { url: Schema.String },
  CompletedCopyLink: {},
  FailedCopyLink: {},
})
export type Message = typeof Message.Type
