import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { ToolReply } from './host'

export const Message = defineMessageUnion({
  ConnectedToHost: { capabilities: Schema.Unknown, context: Schema.Unknown, hostInfo: Schema.Unknown },
  FailedToConnect: { reason: Schema.String },
  ReceivedHostContext: { context: Schema.Unknown },
  ReceivedToolInput: { params: Schema.Unknown },
  ReceivedToolResult: { params: Schema.Unknown },
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
})
export type Message = typeof Message.Type
