import { Schema } from 'effect'

import { McpError } from '@modelcontextprotocol/sdk/types.js'

const CODES = {
  invalid_params: [-32602, 'InvalidParams'],
  not_found: [-32011, 'NotFound'],
  forbidden: [-32012, 'Forbidden'],
  quota: [-32013, 'ResourceExhausted'],
  unsupported: [-32014, 'Unsupported'],
  callback: [-32015, 'CallbackEndpointError'],
  method_not_found: [-32601, 'Method not found'],
} as const

/** Safe public errors only: never put URLs, raw arguments, bodies or secrets in `data`. */
export class McpEventError extends Schema.TaggedError<McpEventError>()('McpEventError', {
  reason: Schema.Literals([
    'invalid_params',
    'not_found',
    'forbidden',
    'quota',
    'unsupported',
    'callback',
    'method_not_found',
  ]),
  data: Schema.optional(Schema.JsonObject),
}) {}

/** The error an MCP lane throws at its Promise boundary: an Error with a numeric `code` (and `data`), as SDK 1 wants. */
export const eventProtocolError = (error: McpEventError): McpError => {
  const [code, message] = CODES[error.reason]
  return new McpError(code, message, error.data)
}

/** The `error` of a `terminated` control. */
export const eventWireError = (error: McpEventError) => {
  const [code, message] = CODES[error.reason]
  return { code, message, ...(error.data === undefined ? {} : { data: error.data }) }
}
