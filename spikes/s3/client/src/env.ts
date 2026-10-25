// Shared config for the S3 spike: testnet endpoints, the USDC SAC, and keys loaded from spikes/s3/.env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Keypair, Networks, rpc } from '@stellar/stellar-sdk'

export const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../.env')
export const RPC_URL = 'https://soroban-testnet.stellar.org'
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'
export const PASSPHRASE = Networks.TESTNET
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

export const server = new rpc.Server(RPC_URL)

export const readEnv = (): Record<string, string> => {
  if (!existsSync(ENV_PATH)) return {}
  return Object.fromEntries(
    readFileSync(ENV_PATH, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
}

export const writeEnv = (env: Record<string, string>) =>
  writeFileSync(
    ENV_PATH,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  )

/** Keypair for a role, e.g. key('relayer') reads S3_RELAYER_SECRET. */
export const key = (role: string): Keypair => {
  const secret = readEnv()[`S3_${role.toUpperCase()}_SECRET`]
  if (!secret) throw new Error(`no key for ${role} in ${ENV_PATH}; run bun src/keys.ts ${role}`)
  return Keypair.fromSecret(secret)
}

export const expert = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`
