/**
 * S2 paying MCP client: MCP SDK 1.32.2 Client over Streamable HTTP, wrapped by @x402/mcp `wrapMCPClientWithPayment`,
 * with an `onPaymentRequested` allowance check (stand-in for the product's grant check), paying from the G account.
 * Every JSON-RPC body on the wire is logged, so `params._meta["x402/payment"]` and `result._meta["x402/payment-response"]`
 * are captured verbatim into .logs/mcp-wire.json.
 *
 *   bun mcp/client.ts [--allowance 0.25] [--pocket]   # --pocket: pay from G(K) after a pull (lib/pocket.ts)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { MCP_PORT } from "../lib/env";
import { txFacts } from "../lib/tx";
import { buildClient } from "../client/pay";
import { key } from "../lib/env";
import { attachPocketPull, ensurePocket } from "../lib/pocket";

const args = process.argv.slice(2);
const flag = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
let remaining = BigInt(Math.round(Number(flag("--allowance") ?? "0.25") * 1e7)); // 7-dp USDC
const url = process.env.MCP_URL ?? `http://127.0.0.1:${MCP_PORT}/mcp`;

const wire: unknown[] = [];
const loggingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const res = await fetch(input as RequestInfo, init);
  const text = await res.clone().text();
  let resBody: unknown = text;
  try {
    resBody = JSON.parse(text);
  } catch {}
  wire.push({ request: reqBody, status: res.status, response: resBody });
  return res;
}) as typeof fetch;

const pocket = args.includes("--pocket") ? key("POCKET") : undefined;
if (pocket) await ensurePocket(pocket);
const { client: x402 } = buildClient(pocket ? { payerSecret: pocket.secret() } : {});
if (pocket) attachPocketPull(x402, pocket, () => {});
const mcp = new Client({ name: "s2-mcp-payer", version: "0.0.0" });
const paying = wrapMCPClientWithPayment(mcp, x402, {
  autoPayment: true,
  onPaymentRequested: ({ toolName, paymentRequired }) => {
    const r = paymentRequired.accepts.find((a) => a.network === "stellar:testnet" && a.scheme === "exact");
    const ok = !!r && BigInt(r.amount) <= remaining;
    console.log(`[mcp-client] ${toolName} asks ${r?.amount ?? "?"} (remaining allowance ${remaining}) → ${ok ? "approve" : "DENY"}`);
    if (ok) remaining -= BigInt(r!.amount);
    return ok;
  },
});
await paying.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: loggingFetch }));
console.log(`[mcp-client] tools: ${(await paying.listTools()).tools.map((t) => t.name).join(", ")}`);

for (const i of [1, 2]) {
  const t0 = performance.now();
  try {
    const r = await paying.callTool("paid_quote", { topic: `call ${i}` });
    console.log(`[mcp-client] call ${i}: ${(performance.now() - t0).toFixed(0)} ms paymentMade=${r.paymentMade} isError=${r.isError ?? false}`);
    console.log(`[mcp-client] content: ${JSON.stringify(r.content)}`);
    console.log(`[mcp-client] paymentResponse: ${JSON.stringify(r.paymentResponse)}`);
    if (r.paymentResponse?.transaction) console.log(`[mcp-client] tx ${JSON.stringify(await txFacts(r.paymentResponse.transaction))}`);
  } catch (e) {
    console.log(`[mcp-client] call ${i}: threw after ${(performance.now() - t0).toFixed(0)} ms: ${e instanceof Error ? e.message : e}`);
  }
}
await paying.close();
const out = join(import.meta.dir, "..", ".logs", "mcp-wire.json");
writeFileSync(out, JSON.stringify(wire, null, 2));
console.log(`[mcp-client] wire log → ${out} (${wire.length} exchanges)`);
