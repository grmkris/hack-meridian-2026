/**
 * S5 constants and .env access. Secrets live only in spikes/s5/.env (gitignored); `bun src/setup.ts` copies the
 * connection key and owner key from spikes/s1/.env and the OZ Channels key from spikes/s2/.env without printing them.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Keypair } from '@stellar/stellar-sdk'

export const NETWORK = 'stellar:testnet' as const
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'
export const HOSTED_FACILITATOR = 'https://www.x402.org/facilitator'
export const OZ_FACILITATOR = 'https://channels.openzeppelin.com/x402/testnet'

/** S1's smart account and the grant it left for S5 (docs/spikes/s1.md, "Ready for S5"). */
export const ACCOUNT = process.env.ACCOUNT_ID ?? 'CD4B4YAP7BCINBT6CKGA3ADE2IOBUAGMH5NZGL2XTQGHTCLF2V4UA753'
export const RULE_ID = Number(process.env.RULE_ID ?? 4)
/** S2's seller payTo (public key only; docs/spikes/s2.md). */
export const PAY_TO = 'GCEKVZO7QV5AC6JLDNWXEYQQ7CS5DSWRDCK3VEQWXGHI6XJN3F4UOANH'
/** S1's merchant G (USDC trustline), used as "a person" for the direct delegated payment. */
export const MERCHANT = 'GDQC6YLG7NYPNKCGWXPTR3DZZZZNRSNCEUMOTYPTNRJMGSYW5LUZW4AG'
export const EXPECTED_CONN = 'GCEM4WKCAWO6ZZAA7SSSTG4SQWLRAI36ZM45QT7QHCPO6SB5ZLVLDH4K'
export const EXPECTED_OWNER = 'GDTLPTGRVKABOS6YMBIDS2SWHFFJ3WGG7NE6G4IV5RJWXRRAQUOTVBG5'

export const HTTP_SELLER_PORT = Number(process.env.HTTP_SELLER_PORT ?? 4051)
export const MCP_SELLER_PORT = Number(process.env.MCP_SELLER_PORT ?? 4052)

export const ENV_PATH = join(import.meta.dir, '..', '.env')

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('#') || !l.includes('=')) continue
    const v = l.slice(l.indexOf('=') + 1).trim()
    out[l.slice(0, l.indexOf('='))] = v.split(/\s+#/)[0]!.trim()
  }
  return out
}

export const readEnv = () => parseEnvFile(ENV_PATH)

export function setEnv(name: string, value: string) {
  appendFileSync(ENV_PATH, `${name}=${value}\n`, { mode: 0o600 })
}

export function secretOf(name: string): string {
  const v = process.env[name] ?? readEnv()[name]
  if (!v) throw new Error(`${name} missing from spikes/s5/.env; run \`bun src/setup.ts\``)
  return v
}

export const relayer = () => Keypair.fromSecret(secretOf('RELAYER_SECRET'))
export const conn = () => Keypair.fromSecret(secretOf('CONN_SECRET'))
export const owner = () => Keypair.fromSecret(secretOf('OWNER_SECRET'))
export const ozKey = () => secretOf('OZ_CHANNELS_API_KEY')

export const explorerTx = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`
export const usdc = (stroops: bigint | number | string) => (Number(stroops) / 1e7).toFixed(7).replace(/(\.\d\d\d*?)0+$/, '$1')
export const ms = (t0: number) => Math.round(performance.now() - t0)
/** JSON with bigint support. */
export const j = (v: unknown, space?: number) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), space)
