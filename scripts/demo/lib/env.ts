import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Stellar } from '../../../apps/seller/demo-deps.ts'

/**
 * Constants and secret handling for the demo scripts. Secret keys live only in scripts/demo/.env (gitignored, mode
 * 600), one `<ROLE>_SECRET=S…` line per account; nothing here prints a secret.
 */
export const DEMO_DIR = resolve(import.meta.dir, '..')
export const ROOT = resolve(DEMO_DIR, '../..')
export const ENV_FILE = join(DEMO_DIR, '.env')
export const SEEDS_FILE = join(DEMO_DIR, 'seeds.json')

export const NETWORK = 'stellar:testnet'
export const PASSPHRASE = Stellar.Networks.TESTNET
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'
export const RPC_URL = process.env['RPC_URL'] ?? 'https://soroban-testnet.stellar.org'
export const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
export const SELLER_URL = (process.env['SELLER_URL'] ?? 'https://hm26-seller.kristjan-grm11775.workers.dev').replace(
  /\/$/u,
  '',
)
export const FACILITATORS = {
  x402org: 'https://www.x402.org/facilitator',
  oz: 'https://channels.openzeppelin.com/x402/testnet',
} as const

export const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`
export const explorerAddress = (address: string) =>
  `https://stellar.expert/explorer/testnet/${address.startsWith('C') ? 'contract' : 'account'}/${address}`

/** The demo's accounts; each maps to `<ROLE>_SECRET` in scripts/demo/.env. */
export const ROLES = ['RELAYER', 'TREASURY', 'SELLER', 'BUYER', 'BOB', 'CAROL', 'ALICE_OWNER', 'OPS'] as const
export type Role = (typeof ROLES)[number]

export function readEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {}
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter(line => line.includes('=') && !line.startsWith('#'))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  )
}

/** Appends `name=value` to scripts/demo/.env (created with mode 600). Never logs the value. */
export function writeEnv(name: string, value: string) {
  appendFileSync(ENV_FILE, `${name}=${value}\n`, { mode: 0o600 })
}

/** The keypair stored as `<role>_SECRET`; generated and persisted on first use unless `create` is false. */
export function key(role: Role, create = true): Stellar.Keypair {
  const name = `${role}_SECRET`
  const existing = process.env[name] ?? readEnv()[name]
  if (existing !== undefined && existing !== '') return Stellar.Keypair.fromSecret(existing)
  if (!create) throw new Error(`${name} missing from scripts/demo/.env; run \`bun scripts/demo/seed.ts\``)
  const keypair = Stellar.Keypair.random()
  writeEnv(name, keypair.secret())
  console.log(`generated ${role}: ${keypair.publicKey()}`)
  return keypair
}

export const hasKey = (role: Role) => (process.env[`${role}_SECRET`] ?? readEnv()[`${role}_SECRET`]) !== undefined

/** A non-secret value remembered in scripts/demo/.env (e.g. ALICE_CONTRACT_ID). */
export const envValue = (name: string): string | undefined => process.env[name] ?? readEnv()[name]

export const usdc = (stroops: bigint) => {
  const sign = stroops < 0n ? '-' : ''
  const abs = stroops < 0n ? -stroops : stroops
  return `${sign}${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, '0')}`
}
export const stroops = (decimal: string) => {
  const [whole = '0', fraction = ''] = decimal.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7))
}
