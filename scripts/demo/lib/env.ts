import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Stellar } from '../../../apps/seller/demo-deps.ts'

/**
 * Constants and secret handling for the demo scripts, per network: `--network testnet|pubnet` on any script (or
 * `STELLAR_NETWORK`), default testnet. Secret keys live only in scripts/demo/.env (testnet) or .env.pubnet (gitignored,
 * mode 600), one `<ROLE>_SECRET=S…` line per account; nothing here prints a secret. Pubnet moves real money: every
 * submitting helper refuses it unless `HM26_MAINNET_GO=yes` (Kristjan's explicit go).
 */
const argNetwork = process.argv.includes('--network') ? process.argv[process.argv.indexOf('--network') + 1] : undefined
export const STELLAR: 'testnet' | 'pubnet' =
  (argNetwork ?? process.env['STELLAR_NETWORK']) === 'pubnet' ? 'pubnet' : 'testnet'
const PUBNET = STELLAR === 'pubnet'

export const DEMO_DIR = resolve(import.meta.dir, '..')
export const ROOT = resolve(DEMO_DIR, '../..')
export const ENV_FILE = join(DEMO_DIR, PUBNET ? '.env.pubnet' : '.env')
export const SEEDS_FILE = join(DEMO_DIR, PUBNET ? 'seeds.pubnet.json' : 'seeds.json')

export const NETWORK: `stellar:${typeof STELLAR}` = `stellar:${STELLAR}`
export const PASSPHRASE = PUBNET ? Stellar.Networks.PUBLIC : Stellar.Networks.TESTNET
export const HORIZON_URL = PUBNET ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
/** Pubnet has no SDF-run public RPC: set RPC_URL to a provider's endpoint. */
export const RPC_URL =
  process.env['RPC_URL'] ?? (PUBNET ? 'https://mainnet.sorobanrpc.com' : 'https://soroban-testnet.stellar.org')
/** USDC SAC: testnet Circle; pubnet is @x402/stellar 2.28.0's USDC_PUBNET_ADDRESS (check docs/research/mainnet.md). */
export const USDC_SAC =
  process.env['USDC_SAC'] ??
  (PUBNET
    ? 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
    : 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA')
export const USDC_ISSUER = PUBNET
  ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const XLM_SAC = PUBNET
  ? 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
  : 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
export const SELLER_URL = (
  process.env['SELLER_URL'] ??
  (PUBNET
    ? 'https://hm26-seller-mainnet.kristjan-grm11775.workers.dev'
    : 'https://hm26-seller.kristjan-grm11775.workers.dev')
).replace(/\/$/u, '')
/** x402.org is testnet-only; a pubnet facilitator comes from FACILITATOR_URL / OZ_FACILITATOR_URL. */
export const FACILITATORS: Readonly<Record<'x402org' | 'oz', string | undefined>> = PUBNET
  ? { x402org: process.env['FACILITATOR_URL'], oz: process.env['OZ_FACILITATOR_URL'] }
  : { x402org: 'https://www.x402.org/facilitator', oz: 'https://channels.openzeppelin.com/x402/testnet' }

export const EXPLORER = (
  process.env['EXPLORER_BASE'] ?? `https://stellar.expert/explorer/${PUBNET ? 'public' : 'testnet'}`
).replace(/\/$/u, '')
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`
export const explorerAddress = (address: string) =>
  `${EXPLORER}/${address.startsWith('C') ? 'contract' : 'account'}/${address}`

/** Throws before any pubnet transaction unless Kristjan gave the go (`HM26_MAINNET_GO=yes`). */
export function assertMayTransact(what: string) {
  if (PUBNET && process.env['HM26_MAINNET_GO'] !== 'yes')
    throw new Error(`refusing ${what} on pubnet: real funds; set HM26_MAINNET_GO=yes only on Kristjan's explicit go`)
}

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
  if (!create) throw new Error(`${name} missing from ${ENV_FILE}; run \`bun scripts/demo/seed.ts\``)
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
