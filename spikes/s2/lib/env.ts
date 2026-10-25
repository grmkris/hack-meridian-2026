/**
 * Shared constants and .env access for spike S2. Secrets live only in spikes/s2/.env (gitignored).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, Networks } from "@stellar/stellar-sdk";

export const NETWORK = "stellar:testnet" as const;
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const HOSTED_FACILITATOR = "https://www.x402.org/facilitator";
export const SELLER_PORT = Number(process.env.SELLER_PORT ?? 4021);
export const SELLER_URL = process.env.SELLER_URL ?? `http://127.0.0.1:${SELLER_PORT}`;
export const MCP_PORT = Number(process.env.MCP_PORT ?? 4022);

export const explorerTx = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;

const ENV = join(import.meta.dir, "..", ".env");

export function readEnv(): Record<string, string> {
  if (!existsSync(ENV)) return {};
  return Object.fromEntries(
    readFileSync(ENV, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

/** Returns the keypair stored as `<NAME>_SECRET`, generating and persisting one if missing. */
export function key(name: string, create = true): Keypair {
  const v = `${name}_SECRET`;
  const existing = process.env[v] ?? readEnv()[v];
  if (existing) return Keypair.fromSecret(existing);
  if (!create) throw new Error(`${v} missing from spikes/s2/.env; run \`bun lib/setup.ts\``);
  const kp = Keypair.random();
  appendFileSync(ENV, `${v}=${kp.secret()}\n`, { mode: 0o600 });
  console.log(`generated ${name}: ${kp.publicKey()}`);
  return kp;
}

export const secret = (name: string) => key(name, false).secret();
export const pub = (name: string) => key(name, false).publicKey();
