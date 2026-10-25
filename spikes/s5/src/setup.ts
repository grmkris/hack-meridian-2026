/**
 * One-time setup for S5 (prints public keys only):
 *   - copies CONN_SECRET and OWNER_SECRET from spikes/s1/.env and OZ_CHANNELS_API_KEY from spikes/s2/.env
 *   - generates a fresh S5 relayer (RELAYER_SECRET) and funds it with friendbot, so S5 never races S1's sponsor sequence
 */
import { join } from 'node:path'

import { Keypair } from '@stellar/stellar-sdk'

import { EXPECTED_CONN, EXPECTED_OWNER, parseEnvFile, readEnv, setEnv } from './env'

const s1 = parseEnvFile(join(import.meta.dir, '..', '..', 's1', '.env'))
const s2 = parseEnvFile(join(import.meta.dir, '..', '..', 's2', '.env'))
const mine = readEnv()

for (const [name, from, src] of [
  ['CONN_SECRET', s1, 's1'],
  ['OWNER_SECRET', s1, 's1'],
  ['OZ_CHANNELS_API_KEY', s2, 's2'],
] as const) {
  if (mine[name]) continue
  const v = from[name]
  if (!v) throw new Error(`${name} not found in spikes/${src}/.env`)
  setEnv(name, v)
  console.log(`copied ${name} from spikes/${src}/.env`)
}
const env = readEnv()
const connPub = Keypair.fromSecret(env.CONN_SECRET!).publicKey()
const ownerPub = Keypair.fromSecret(env.OWNER_SECRET!).publicKey()
console.log(`conn K  ${connPub} ${connPub === EXPECTED_CONN ? '(matches S1 rule 4 signer)' : 'MISMATCH'}`)
console.log(`owner   ${ownerPub} ${ownerPub === EXPECTED_OWNER ? '(matches S1 rule 0)' : 'MISMATCH'}`)
console.log(`oz key  ${env.OZ_CHANNELS_API_KEY ? `present (${env.OZ_CHANNELS_API_KEY.length} chars)` : 'missing'}`)

if (!env.RELAYER_SECRET) {
  const kp = Keypair.random()
  setEnv('RELAYER_SECRET', kp.secret())
  const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)
  console.log(`relayer ${kp.publicKey()} generated, friendbot ${r.status}`)
} else {
  console.log(`relayer ${Keypair.fromSecret(env.RELAYER_SECRET).publicKey()} (existing)`)
}
