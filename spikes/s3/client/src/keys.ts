// Usage: bun src/keys.ts <role>... [--no-fund]
// Generates a keypair per missing role into spikes/s3/.env and funds it with friendbot. Prints public keys only.
import { Keypair } from '@stellar/stellar-sdk'

import { readEnv, writeEnv } from './env'

const args = process.argv.slice(2)
const fund = !args.includes('--no-fund')
const env = readEnv()
for (const role of args.filter(a => !a.startsWith('--'))) {
  const name = `S3_${role.toUpperCase()}_SECRET`
  if (!env[name]) env[name] = Keypair.random().secret()
  writeEnv(env)
  const pub = Keypair.fromSecret(env[name]!).publicKey()
  if (fund) {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
    console.log(`${role}: ${pub} friendbot ${res.status}`)
  } else console.log(`${role}: ${pub}`)
}
