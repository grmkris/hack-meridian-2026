/**
 * S2 paid MCP server: stateless Streamable HTTP (@modelcontextprotocol/sdk 1.32.2, web-standard transport on Bun),
 * one tool `paid_quote` wrapped by @x402/mcp 2.28.0 `createPaymentWrapper`, priced $0.10 on stellar:testnet,
 * plus a free `ping`.
 *
 *   bun mcp/server.ts                    # hosted facilitator (x402.org)
 *   FACILITATOR=local bun mcp/server.ts  # in-process facilitator
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FacilitatorClient } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { z } from "zod";
import { HOSTED_FACILITATOR, MCP_PORT, NETWORK, pub } from "../lib/env";
import { localFacilitator } from "../facilitator/local";

const PAY_TO = process.env.STELLAR_PAY_TO ?? pub("PAYTO");
const MODE = process.env.FACILITATOR === "local" ? "local" : "hosted";
const fac: FacilitatorClient = MODE === "local" ? localFacilitator() : new HTTPFacilitatorClient({ url: HOSTED_FACILITATOR });

const rs = new x402ResourceServer(fac).register(NETWORK, new ExactStellarScheme());
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
