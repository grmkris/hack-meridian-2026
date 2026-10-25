/**
 * S1 claim 6: a passkey-admin smart account. Rule 0 holds ONLY a secp256r1 WebAuthn signer
 * (software P-256 key producing browser-identical assertion bytes). Proves, on testnet:
 *   1. deploy with the passkey as the only admin (sponsor pays)
 *   2. passkey-approved USDC transfer via the split approval-page API
 *      prepareInvocation → webAuthnChallenge → navigator.credentials.get (simulated) → authorizeWithWebAuthn → finalizeInvocation
 *   3. negatives: wrong challenge, UV bit cleared
 *   4. passkey installs a connection rule (the consent screen), conn pulls 0.5 USDC into its pocket G under it
 *
 *   bun src/webauthn-demo.ts
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Keypair } from '@stellar/stellar-sdk'

import {
  InvokeError,
  LEDGERS_PER_DAY,
  SoftPasskey,
  USDC,
  USDC_SAC,
  addConnectionRule,
  addr,
  deployAccount,
  ed25519Signer,
  explorerContract,
  finalizeInvocation,
  i128,
  invokeAs,
  latestLedger,
  prepareInvocation,
  readSpendingLimit,
  tokenBalance,
  transferAs,
  u32,
  view,
  webAuthnChallenge,
  authorizeWithWebAuthn,
  webAuthnSignatureBytes,
  type SmartSigner,
  type TxReport,
} from './signer'

const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} missing: run bun src/setup.ts`)
  return v
}
const ENV = join(import.meta.dir, '..', '.env')
// a second sponsor G so this can run next to demo.ts without sequence contention
const sponsor = Keypair.fromSecret(process.env.SPONSOR2_SECRET ?? env('SPONSOR_SECRET'))
const funder = Keypair.fromSecret(env('FUNDER_SECRET'))
const connKp = Keypair.fromSecret(env('CONN_SECRET'))
const merchant = Keypair.fromSecret(env('MERCHANT_SECRET')).publicKey()
const pocket = connKp.publicKey()
const conn = ed25519Signer(connKp, 'conn')

// Persist the software passkey so reruns can reuse the account.
let passkey: SoftPasskey
if (process.env.PASSKEY_PKCS8 && process.env.PASSKEY_CRED_ID) {
  passkey = new SoftPasskey(
    'localhost',
    'http://localhost:5173',
    Buffer.from(process.env.PASSKEY_PKCS8, 'base64'),
    Buffer.from(process.env.PASSKEY_CRED_ID, 'base64url'),
  )
} else {
  passkey = new SoftPasskey()
  appendFileSync(
    ENV,
    `PASSKEY_PKCS8=${passkey.exportPkcs8().toString('base64')}\nPASSKEY_CRED_ID=${passkey.credentialId.toString('base64url')}\n`,
    { mode: 0o600 },
  )
}

const log: Array<Record<string, unknown>> = []
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
const fmt = (n: bigint) => (Number(n) / 1e7).toFixed(7)
const show = (step: string, r: TxReport) => {
  console.log(
    `PASS  ${step}\n      ${r.hash} ledger=${r.ledger} feeCharged=${r.feeCharged} resourceFee=${r.resourceFee} ${json(r.timings)} ${r.credentialTypes ?? ''}\n      ${r.explorer}`,
  )
  log.push({ step, ok: true, ...r })
}
async function reject(step: string, f: () => Promise<unknown>) {
  try {
    await f()
    console.log(`!!!!  ${step}: expected a rejection but it PASSED`)
    log.push({ step, expected: 'REJECT', ok: false })
  } catch (e) {
    if (!(e instanceof InvokeError)) throw e
    console.log(`REJ   ${step}\n      stage=${e.stage} ${e.contractError ?? ''} ${e.detail.split('\n')[0]?.slice(0, 200)}`)
    log.push({ step, expected: 'REJECT', ok: true, stage: e.stage, contractError: e.contractError, detail: e.detail.slice(0, 3000) })
  }
}

const started = Date.now()
let account = process.env.PASSKEY_ACCOUNT_ID ?? ''
try {
  console.log(
    `passkey pubkey=${passkey.publicKey65.toString('hex')} credId=${passkey.credentialId.toString('base64url')} rpId=${passkey.rpId}`,
  )
  const admin: SmartSigner = passkey.asSigner('passkey')

  // 1. Deploy: passkey is the only signer of rule 0.
  if (!account) {
    const d = await deployAccount(sponsor, admin)
    account = d.contractId
    show(`claim6 deploy passkey-admin account → ${account}`, d)
    console.log(`      ${explorerContract(account)}`)
    appendFileSync(ENV, `PASSKEY_ACCOUNT_ID=${account}\n`, { mode: 0o600 })
    const fund = await invokeAs(
      funder,
      funder.publicKey(),
      [],
      [],
      USDC_SAC,
      'transfer',
      [addr(funder.publicKey()), addr(account), i128(USDC(3))],
      { label: 'fund' },
    )
    show('claim6 fund 3 USDC', fund)
  }
  const rule0 = await view(sponsor.publicKey(), account, 'get_context_rule', [u32(0)])
  console.log(`      rule0=${json(rule0)}`)
  log.push({ step: 'rule0', rule0 })

  // 2. Passkey-approved transfer through the split approval-page API.
  const args = [addr(account), addr(merchant), i128(USDC(1))]
  const prep = await prepareInvocation(sponsor, USDC_SAC, 'transfer', args)
  const entry = prep.entries[0]!
  const { digest, challengeB64url } = webAuthnChallenge(entry, [0], prep.validUntilLedger)
  // ↓ in the product this happens in the browser: navigator.credentials.get({publicKey:{challenge: digest, rpId, allowCredentials, userVerification:'required'}})
  const assertion = passkey.assert(digest)
  const wire = {
    challenge: challengeB64url,
    validUntilLedger: prep.validUntilLedger,
    authenticatorData: Buffer.from(assertion.authenticatorData).toString('base64url'),
    clientDataJSON: Buffer.from(assertion.clientDataJSON).toString('utf8'),
    signatureDER: Buffer.from(assertion.signature).toString('base64url'),
    sigDataXdrBase64: webAuthnSignatureBytes(assertion).toString('base64'),
  }
  console.log(`      approval-page wire payload: ${json(wire)}`)
  log.push({ step: 'assertion wire shape', wire })
  // The approval happens minutes later; meanwhile the relayer sends other transactions. Advance its sequence
  // with an unrelated tx to prove finalize does not depend on the prepare-time sequence.
  {
    const { Account, Operation: Op, TransactionBuilder: TB, Networks } = await import('@stellar/stellar-sdk')
    const { server } = await import('./signer')
    const a = await server.getAccount(sponsor.publicKey())
    const bump = new TB(new Account(sponsor.publicKey(), a.sequenceNumber()), { fee: '1000', networkPassphrase: Networks.TESTNET })
      .addOperation(Op.bumpSequence({ bumpTo: (BigInt(a.sequenceNumber()) + 1n).toString() }))
      .setTimeout(60)
      .build()
    bump.sign(sponsor)
    const sent = await server.sendTransaction(bump)
    await server.pollTransaction(sent.hash)
    console.log(`      relayer sent an unrelated tx between prepare and finalize: ${sent.hash}`)
    log.push({ step: 'interleaved relayer tx', hash: sent.hash })
  }
  const signed = await authorizeWithWebAuthn(entry, assertion, {
    signerScVal: passkey.scVal,
    ruleIds: [0],
    validUntilLedger: prep.validUntilLedger,
  })
  const t = await finalizeInvocation(sponsor, prep, [signed], 'passkey transfer 1 USDC')
  show('claim6 passkey (rule 0) transfers 1 USDC to merchant', { ...t, credentialTypes: entry.credentials().switch().name })

  // 3. Negatives against the deployed WebAuthn verifier.
  const wrongChallenge: SmartSigner = {
    label: 'passkey-wrong-challenge',
    scVal: passkey.scVal,
    sign: async d => webAuthnSignatureBytes(passkey.assert(Buffer.from(d).reverse())),
  }
  await reject('claim6 neg: assertion over a different challenge', () =>
    transferAs(sponsor, account, wrongChallenge, 0, merchant, USDC(0.1)),
  )
  const noUv: SmartSigner = {
    label: 'passkey-no-uv',
    scVal: passkey.scVal,
    sign: async d => {
      const a = passkey.assert(d)
      // re-sign with UV cleared so only the flag check can fail
      const ad = Buffer.from(a.authenticatorData)
      ad[32] = 0x01
      const { createHash, sign } = await import('node:crypto')
      const msg = Buffer.concat([ad, createHash('sha256').update(a.clientDataJSON).digest()])
      return webAuthnSignatureBytes({
        authenticatorData: ad,
        clientDataJSON: a.clientDataJSON,
        signature: sign('sha256', msg, { key: passkey.privateKey, dsaEncoding: 'der' }),
      })
    },
  }
  await reject('claim6 neg: UV flag not set', () => transferAs(sponsor, account, noUv, 0, merchant, USDC(0.1)))
  const otherKey = new SoftPasskey()
  const impostor: SmartSigner = {
    label: 'impostor',
    scVal: passkey.scVal,
    sign: async d => webAuthnSignatureBytes(otherKey.assert(d)),
  }
  await reject('claim6 neg: signature from a different P-256 key', () =>
    transferAs(sponsor, account, impostor, 0, merchant, USDC(0.1)),
  )

  // 4. Consent screen: passkey installs the connection grant; connection pulls into its pocket under it.
  const now = await latestLedger()
  const add = await addConnectionRule(sponsor, account, admin, {
    token: USDC_SAC,
    connection: conn,
    name: 'mcp-conn-passkey',
    spendingLimit: USDC(1),
    periodLedgers: LEDGERS_PER_DAY + 720,
    validUntilLedger: now + LEDGERS_PER_DAY,
  })
  show(`claim6 passkey installs connection rule → id ${add.ruleId}`, add)
  const pull = await transferAs(sponsor, account, conn, add.ruleId, pocket, USDC(0.5))
  show(`claim6 conn pulls 0.5 USDC into pocket under rule ${add.ruleId}`, pull)
  const d = await readSpendingLimit(sponsor.publicKey(), account, add.ruleId)
  console.log(`      policy(rule ${add.ruleId}) spent=${fmt(d.cached_total_spent)} limit=${fmt(d.spending_limit)} history=${json(d.spending_history)}`)
  log.push({ step: 'policy', ...d })
  await reject('claim6 conn 0.6 USDC (cum 1.1 > 1)', () => transferAs(sponsor, account, conn, add.ruleId, pocket, USDC(0.6)))
  console.log(`      balances: C=${fmt(await tokenBalance(sponsor.publicKey(), account))} pocket=${fmt(await tokenBalance(sponsor.publicKey(), pocket))}`)
} finally {
  mkdirSync(join(import.meta.dir, '..', 'out'), { recursive: true })
  const f = join(import.meta.dir, '..', 'out', `webauthn-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(f, JSON.stringify({ account, durationMs: Date.now() - started, log }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2))
  console.log(`log → ${f}  (account ${account})`)
}
