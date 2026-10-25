import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import type { AppRuntime } from './runtime.ts'
import type { ToolContext } from './tools.ts'

/**
 * MCP Apps: the `ui://` resources Nod's tools render with (cards in the chat). The legacy lane declares
 * `appsCapabilities` and calls `registerApps` on each request's Server; the cards stream fills both in.
 */
export const appsCapabilities = {}

export const registerApps = (server: Server, runtime: AppRuntime, ctx: ToolContext): void => {
  void server
  void runtime
  void ctx
}
