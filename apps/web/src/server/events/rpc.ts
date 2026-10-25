import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import type { AppRuntime } from '../runtime.ts'
import type { ToolContext } from '../tools.ts'

/**
 * MCP Events (SEP-3415, `events/*`): the legacy lane declares `eventsCapabilities` and calls `registerEvents` on each
 * request's Server; the events stream fills both in.
 */
export const eventsCapabilities = {}

export const registerEvents = (server: Server, runtime: AppRuntime, ctx: ToolContext): void => {
  void server
  void runtime
  void ctx
}
