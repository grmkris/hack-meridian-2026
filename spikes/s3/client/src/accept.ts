// Usage: bun src/accept.ts [--recipient <role>] [--amount <stroops>]
// The product's acceptance ("claim") link, end to end on testnet, driven only through lib.ts:
//   1. server: simulate pay_and_trust, keep the recipient's unsigned trust entry as base64 XDR (goes into the link)
//   2. recipient page: decode it, sign through a wallet-style signAuthEntry(preimageXdr) callback, post it back
//   3. server: sender signs its transfer entry, enforce re-simulation, relayer submits
// The wallet here is a stub with Freighter's signAuthEntry contract (sha256 of the preimage XDR, ed25519, base64).
import { createHash } from 'node:crypto'

import { xdr, type Keypair } from '@stellar/stellar-sdk'

import { expert, key, PASSPHRASE, server, USDC_SAC } from './env'
import {
  buildTx,
  describeEntry,
  payAndTrustFunc,
  signEntries,
  simulateUnsigned,
  submitSigned,
  walletSigner,
} from './lib'
import { ROUTER } from './router'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : fallback
}
const relayer = key('relayer')
const sender = key('sender')
const recipient = key(arg('recipient', 'recipient_link'))
const amount = BigInt(arg('amount', '10000000'))

const stubFreighter =
  (kp: Keypair) => async (preimageXdr: string, opts: { networkPassphrase: string; address: string }) => {
    if (opts.address !== kp.publicKey()) return { signedAuthEntry: null, error: 'wrong account' }
    const payload = createHash('sha256').update(Buffer.from(preimageXdr, 'base64')).digest()
    return { signedAuthEntry: Buffer.from(kp.sign(payload)).toString('base64'), signerAddress: kp.publicKey() }
  }

// 1. server
const p = { router: ROUTER, sender: sender.publicKey(), recipient: recipient.publicKey(), token: USDC_SAC, amount }
const func = payAndTrustFunc(p)
const seq = (await server.getAccount(relayer.publicKey())).sequenceNumber()
const { entries, latestLedger } = await simulateUnsigned(
  server,
  buildTx(relayer.publicKey(), seq, func, [], PASSPHRASE),
)
const validUntil = latestLedger + Number(arg('valid-ledgers', '720')) // default ~1 hour for the link
const recipientEntry = entries.find(e => describeEntry(e).who === recipient.publicKey())
const senderEntry = entries.find(e => describeEntry(e).who === sender.publicKey())
if (!recipientEntry || !senderEntry)
  throw new Error(`expected 2 entries, got ${entries.map(e => describeEntry(e).who)}`)
const linkPayload = recipientEntry.toXDR('base64')
console.log(`1. link payload (recipient trust entry, ${linkPayload.length} b64 chars):`, describeEntry(recipientEntry))

// 2. recipient page
const decoded = xdr.SorobanAuthorizationEntry.fromXDR(linkPayload, 'base64')
const [recipientSigned] = await signEntries(
  [decoded],
  { [recipient.publicKey()]: walletSigner(stubFreighter(recipient), recipient.publicKey(), PASSPHRASE) },
  validUntil,
  PASSPHRASE,
)
const posted = recipientSigned!.toXDR('base64')
console.log('2. recipient signed via signAuthEntry callback:', describeEntry(recipientSigned!))

// 3. server
const [senderSigned] = await signEntries([senderEntry], { [sender.publicKey()]: sender }, validUntil, PASSPHRASE)
const res = await submitSigned(
  server,
  relayer,
  func,
  [xdr.SorobanAuthorizationEntry.fromXDR(posted, 'base64'), senderSigned!],
  PASSPHRASE,
)
console.log(`3. ${res.status} ${expert(res.hash)} (enforce minResourceFee=${res.minResourceFee})`)
