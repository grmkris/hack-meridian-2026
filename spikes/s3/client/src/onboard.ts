// Usage: bun src/onboard.ts [--recipient <role>] [--amount <stroops>] [--omit-recipient]
//
// One transaction, relayer = source + fee payer:
//   router.pay_and_trust(sender, recipient, USDC_SAC, amount)
//     -> USDC_SAC.trust(recipient)                        recipient's auth entry (root = this call)
//     -> USDC_SAC.transfer(sender, recipient, amount)     sender's auth entry (root = this call)
//
// Flow: simulate (authMode record_allow_nonroot) -> authorizeEntry per signer -> re-simulate (enforce, signed) ->
// assembleTransaction -> relayer signs envelope -> sendTransaction -> poll.
// --omit-recipient: negative test. Drops the recipient's entry, shows the enforce-mode simulation error, then submits
// anyway with the first simulation's footprint so the rejection is onchain with a hash.
import {
  Asset,
  authorizeEntry,
  Horizon,
  humanizeEvents,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  type Keypair,
} from '@stellar/stellar-sdk'

import { expert, HORIZON_URL, key, PASSPHRASE, server, USDC_ISSUER, USDC_SAC } from './env'
import { buildTx, describeEntry, payAndTrustFunc } from './lib'
import { ROUTER } from './router'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : fallback
}
const omitRecipient = process.argv.includes('--omit-recipient')
// --trust-first: after both parties sign, the recipient adds the trustline classically (ChangeTrust), so the signed
// recipient entry is no longer needed when the payment lands. Answers "does an unused auth entry fail the tx?".
const trustFirst = process.argv.includes('--trust-first')
const recipientRole = arg('recipient', 'recipient')
const amount = BigInt(arg('amount', '50000000')) // 5 USDC, 7 decimals

const relayer = key('relayer')
const sender = key('sender')
const recipient = key(recipientRole)
const signers: Record<string, Keypair> = { [sender.publicKey()]: sender, [recipient.publicKey()]: recipient }
const horizon = new Horizon.Server(HORIZON_URL)

const balances = async (who: string) =>
  (await horizon.loadAccount(who)).balances
    .map(b => `${'asset_code' in b ? b.asset_code : 'XLM'}=${b.balance}`)
    .join(' ')

const p = { router: ROUTER, sender: sender.publicKey(), recipient: recipient.publicKey(), token: USDC_SAC, amount }
const func = payAndTrustFunc(p)
const relayerSeq = (await server.getAccount(relayer.publicKey())).sequenceNumber()
const build = (auth: xdr.SorobanAuthorizationEntry[]) =>
  buildTx(relayer.publicKey(), relayerSeq, func, auth, PASSPHRASE)

console.log(`relayer   ${relayer.publicKey()}  ${await balances(relayer.publicKey())}`)
console.log(`sender    ${sender.publicKey()}  ${await balances(sender.publicKey())}`)
console.log(`recipient ${recipient.publicKey()}  ${await balances(recipient.publicKey())}`)

// 0) Default simulation (authMode "record") for the record: non-root auth is refused.
const sim0 = await server.simulateTransaction(build([]))
if (rpc.Api.isSimulationError(sim0)) console.log(`\n[sim authMode=record] ERROR: ${sim0.error.split('\n')[0]}`)
else console.log('\n[sim authMode=record] unexpectedly succeeded')

// 1) Recording simulation that allows non-root auth.
const sim1 = await server.simulateTransaction(build([]), { cpuInstructions: 2_000_000 }, 'record_allow_nonroot')
if (!rpc.Api.isSimulationSuccess(sim1)) throw new Error(`sim1 failed: ${JSON.stringify(sim1, null, 1)}`)
const entries = sim1.result!.auth
console.log(
  `\n[sim authMode=record_allow_nonroot] ok, ${entries.length} auth entries, minResourceFee=${sim1.minResourceFee}`,
)
for (const e of entries) console.log('  entry', describeEntry(e))

// 2) Each party signs only its own entry.
const validUntil = sim1.latestLedger + 120 // ~10 minutes
const signed: xdr.SorobanAuthorizationEntry[] = []
for (const e of entries) {
  const { who } = describeEntry(e)
  if (omitRecipient && who === recipient.publicKey()) {
    console.log(`  NOT signing / dropping entry for recipient ${who}`)
    continue
  }
  const kp = signers[who]
  if (!kp) throw new Error(`no signer for ${who}`)
  signed.push(await authorizeEntry(e, kp, validUntil, PASSPHRASE))
  console.log(`  signed by ${who === sender.publicKey() ? 'sender' : 'recipient'} (valid until ledger ${validUntil})`)
}

if (trustFirst) {
  const acct = await horizon.loadAccount(recipient.publicKey())
  const ct = new TransactionBuilder(acct, { fee: '10000', networkPassphrase: PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(60)
    .build()
  ct.sign(recipient)
  const res = await horizon.submitTransaction(ct)
  console.log(`\nrecipient added the trustline itself first (classic ChangeTrust): ${expert(res.hash)}`)
}

// 3) Re-simulate with the signed entries (enforcing auth) for exact resources.
const sim2 = await server.simulateTransaction(build(signed), undefined, 'enforce')
let assembled
if (rpc.Api.isSimulationSuccess(sim2)) {
  console.log(`\n[sim enforce, signed] ok, minResourceFee=${sim2.minResourceFee}`)
  assembled = rpc.assembleTransaction(build(signed), sim2).build()
} else {
  const err = rpc.Api.isSimulationError(sim2) ? sim2.error : JSON.stringify(sim2)
  console.log(`\n[sim enforce, signed] ERROR:\n${err}`)
  if (!omitRecipient && !trustFirst) process.exit(1)
  console.log('\nsubmitting anyway with the record-mode footprint to get the onchain rejection')
  assembled = rpc.assembleTransaction(build(signed), sim1).build()
}

// 4) Relayer signs the envelope and pays the fee.
assembled.sign(relayer)
const sent = await server.sendTransaction(assembled)
console.log(`\nsendTransaction: ${sent.status} ${sent.hash}`)
if (sent.status === 'ERROR') {
  console.log(JSON.stringify(sent.errorResult?.toXDR('base64')))
  process.exit(1)
}
const final = await server.pollTransaction(sent.hash, { attempts: 30 })
console.log(`result: ${final.status}  ${expert(sent.hash)}`)
if (final.status === rpc.Api.GetTransactionStatus.SUCCESS || final.status === rpc.Api.GetTransactionStatus.FAILED) {
  const r = final.resultXdr as unknown as { feeCharged: bigint; result: unknown }
  const code = JSON.stringify(r.result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 200)
  console.log(`feeCharged=${r.feeCharged} stroops (paid by relayer) result=${code}`)
  if (final.status === rpc.Api.GetTransactionStatus.FAILED && final.diagnosticEventsXdr?.length) {
    for (const ev of humanizeEvents(final.diagnosticEventsXdr))
      console.log('  diag', JSON.stringify(ev, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 400))
  }
}
console.log(`\nrecipient after: ${await balances(recipient.publicKey())}`)
console.log(`sender after:    ${await balances(sender.publicKey())}`)
