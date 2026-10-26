import { Schema } from 'effect'
import { File } from 'foldkit/file'
import { defineMessageUnion } from 'foldkit/message'

import { RecipientReadOutput } from '@hm/protocol'

export const Message = defineMessageUnion({
  Connected: { capabilities: Schema.Unknown, context: Schema.Unknown },
  ReceivedContext: { context: Schema.Unknown },
  ReceivedResult: { result: Schema.Unknown },
  FailedConnection: {},
  ClickedCamera: {},
  SucceededCamera: { attempt: Schema.Int },
  FailedCamera: { attempt: Schema.Int, reason: Schema.String },
  ClickedCapture: {},
  SelectedFiles: { files: Schema.Array(File) },
  SucceededRead: { attempt: Schema.Int, recipient: RecipientReadOutput },
  FailedRead: { attempt: Schema.Int, reason: Schema.String },
  ClickedReset: {},
  BecameHidden: {},
  ClickedUse: {},
  SucceededShare: { attempt: Schema.Int },
  FailedShare: { attempt: Schema.Int, reason: Schema.String },
  ClickedCopy: {},
  CompletedCopy: { attempt: Schema.Int, copied: Schema.Boolean },
})
export type Message = typeof Message.Type
