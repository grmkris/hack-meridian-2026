/**
 * S2 paid MCP server: stateless Streamable HTTP (@modelcontextprotocol/sdk 1.32.2, web-standard transport on Bun),
 * one tool `paid_quote` wrapped by @x402/mcp 2.28.0 `createPaymentWrapper`, priced $0.10 on stellar:testnet,
 * plus a free `ping`.
 *
 *   bun mcp/server.ts                    # x402.org facilitator
 *   FACILITATOR=oz bun mcp/server.ts     # OpenZeppelin Channels testnet
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { z } from "zod";
import { MCP_PORT, NETWORK, pub } from "../lib/env";
import { facilitatorClient, facilitatorFromEnv } from "../lib/facilitators";

const PAY_TO = process.env.STELLAR_PAY_TO ?? pub("PAYTO");
const MODE = facilitatorFromEnv();
const rs = new x402ResourceServer(facilitatorClient(MODE)).register(NETWORK, new ExactStellarScheme());
await rs.initialize();
const accepts = await rs.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.10", maxTimeoutSeconds: 60 });
console.log(`[mcp-seller] ${MODE} facilitator; accepts ${JSON.stringify(accepts)}`);

const paid = createPaymentWrapper(rs, {
  accepts,
  resource: { url: "mcp://tool/paid_quote", description: "S2 paid quote over MCP", mimeType: "application/json" },
  hooks: {
    onBeforeExecution: ({ paymentPayload }) => void console.log(`[mcp-seller] verified payment from ${JSON.stringify(paymentPayload.accepted?.payTo)} → executing`),
    onAfterSettlement: ({ settlement }) => void console.log(`[mcp-seller] settled ${JSON.stringify(settlement)}`),
  },
});

let served = 0;
function build() {
  const mcp = new McpServer({ name: "s2-paid-mcp", version: "0.0.0" });
  mcp.registerTool("ping", { description: "free", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  mcp.registerTool(
    "paid_quote",
    { description: "A quote for 0.10 USDC (x402, stellar:testnet)", inputSchema: { topic: z.string().optional() } },
    paid(async (args: { topic?: string }) => ({
      content: [{ type: "text", text: JSON.stringify({ quote: `Ledgers close every ~5s (${args.topic ?? "general"}).`, served: ++served }) }],
    })) as never,
  );
  return mcp;
}

Bun.serve({
  port: MCP_PORT,
  idleTimeout: 120,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await build().connect(transport);
    return transport.handleRequest(req);
  },
});
console.log(`[mcp-seller] http://127.0.0.1:${MCP_PORT}/mcp payTo ${PAY_TO}`);
