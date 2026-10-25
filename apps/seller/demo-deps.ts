/**
 * npm dependencies of `scripts/demo/*`, re-exported from this workspace. `scripts/` is not a workspace member and
 * Bun's isolated linker exposes a package only to the workspace that declares it, so the demo scripts import their
 * Stellar, x402 and MCP client libraries through this file (one pinned copy, the seller's). Delete this file and
 * import directly if `scripts/demo` ever becomes a workspace.
 */
export * as Stellar from '@stellar/stellar-sdk'
export { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
export { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
export type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
export type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
export { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch'
export { createEd25519Signer } from '@x402/stellar'
export { ExactStellarScheme as ExactStellarClientScheme } from '@x402/stellar/exact/client'
export { appendPaymentIdentifierToExtensions, generatePaymentId } from '@x402/extensions/payment-identifier'
export { wrapMCPClientWithPayment } from '@x402/mcp'
export { decodePaymentRequiredHeader } from '@x402/core/http'
export type { SettleResponse } from '@x402/core/types'
