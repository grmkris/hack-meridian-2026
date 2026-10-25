// Usage: bun src/create.ts <role> <xlm>
// The relayer creates <role> with exactly <xlm> starting balance (classic CreateAccount), no trustlines.
// Used for the reserve test: 1.5 XLM is the floor for an account with one trustline (2 + 1 base reserves of 0.5).
import { Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

import { expert, HORIZON_URL, key, PASSPHRASE, readEnv, writeEnv } from './env'

const [role, xlm] = process.argv.slice(2)
if (!role || !xlm) throw new Error('usage: bun src/create.ts <role> <xlm>')
const env = readEnv()
const name = `S3_${role.toUpperCase()}_SECRET`
env[name] ??= Keypair.random().secret()
writeEnv(env)
const kp = Keypair.fromSecret(env[name]!)
const relayer = key('relayer')
const horizon = new Horizon.Server(HORIZON_URL)
const tx = new TransactionBuilder(await horizon.loadAccount(relayer.publicKey()), {
  fee: '10000',
  networkPassphrase: PASSPHRASE,
})
  .addOperation(Operation.createAccount({ destination: kp.publicKey(), startingBalance: xlm }))
  .setTimeout(60)
  .build()
tx.sign(relayer)
const res = await horizon.submitTransaction(tx)
console.log(`${role}: ${kp.publicKey()} created with ${xlm} XLM: ${expert(res.hash)}`)
