/**
 * Generate a free OpenZeppelin Channels testnet API key and store it in spikes/s2/.env as OZ_CHANNELS_API_KEY.
 * Prints only the HTTP status and the response's field names, never the key.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { readEnv } from "./env";

if (readEnv().OZ_CHANNELS_API_KEY) {
  console.log("OZ_CHANNELS_API_KEY already in .env");
  process.exit(0);
}
for (const method of ["GET", "POST"]) {
  const r = await fetch("https://channels.openzeppelin.com/testnet/gen", { method });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  const shape = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "object" && v ? Object.keys(v) : typeof v]));
  console.log(`${method} /testnet/gen → ${r.status} fields ${JSON.stringify(shape)}`);
  const key = (body.apiKey ?? body.api_key ?? body.key ?? (body.data as Record<string, unknown> | undefined)?.apiKey ?? (body.data as Record<string, unknown> | undefined)?.key) as string | undefined;
  if (r.ok && typeof key === "string") {
    appendFileSync(join(import.meta.dir, "..", ".env"), `OZ_CHANNELS_API_KEY=${key}\n`, { mode: 0o600 });
    console.log(`stored OZ_CHANNELS_API_KEY (${key.length} chars) in spikes/s2/.env`);
    process.exit(0);
  }
}
console.log("no key found in the response");
process.exit(1);
