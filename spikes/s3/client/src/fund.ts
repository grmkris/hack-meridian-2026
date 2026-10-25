// Usage: bun src/fund.ts <role> <usdc>
// Gives <role> a USDC trustline (classic ChangeTrust) and buys <usdc> Circle testnet USDC on the testnet SDEX
// with a strict-receive path payment from its own XLM. No faucet needed.
import { Asset, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

import { expert, HORIZON_URL, key, PASSPHRASE, USDC_ISSUER } from './env'

const [role = 'sender', amount = '20'] = process.argv.slice(2)
const kp = key(role)
const horizon = new Horizon.Server(HORIZON_URL)
const usdc = new Asset('USDC', USDC_ISSUER)
const account = await horizon.loadAccount(kp.publicKey())
const tx = new TransactionBuilder(account, { fee: '10000', networkPassphrase: PASSPHRASE })
  .addOperation(Operation.changeTrust({ asset: usdc }))
  .addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: String(Number(amount) * 3),
      destination: kp.publicKey(),
      destAsset: usdc,
      destAmount: amount,
      path: [],
    }),
  )
  .setTimeout(60)
  .build()
tx.sign(kp)
const res = await horizon.submitTransaction(tx)
console.log(`${role} ${kp.publicKey()} bought ${amount} USDC: ${res.hash} ${expert(res.hash)}`)
const after = await horizon.loadAccount(kp.publicKey())
console.log(after.balances.map(b => `${'asset_code' in b ? b.asset_code : 'XLM'}=${b.balance}`).join(' '))
