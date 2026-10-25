/**
 * S1 signer module: drive an OpenZeppelin smart account (stellar-accounts v0.7.x build, WASM 1b5f4534…)
 * on Stellar testnet with @stellar/stellar-sdk 16.4.1, no Smart Account Kit at runtime.
 *
 * Flow for every smart-account authorization (admin call or delegated payment):
 *   simulate (record) → authorize the C-account entry (AuthPayload with the chosen rule ids)
 *   → simulate again in enforce mode (runs __check_auth, the verifier and the policy)
 *   → assemble → sponsor signs the envelope → send → poll.
 * The sponsor G account is the transaction source and pays every fee; the C-account holds no XLM.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'

import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

// ---------------------------------------------------------------------------------------------
// Testnet constants (docs/research/smart-accounts.md (a), re-checked 2026-10-25)
// ---------------------------------------------------------------------------------------------
export const NETWORK_PASSPHRASE = Networks.TESTNET
export const RPC_URL = process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org'
export const ACCOUNT_WASM_HASH = '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a'
export const ED25519_VERIFIER = 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4'
export const WEBAUTHN_VERIFIER = 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F'
export const SPENDING_LIMIT_POLICY = 'CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G'
export const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const LEDGERS_PER_DAY = 17_280
export const USDC = (n: number) => BigInt(Math.round(n * 10_000_000)) // 7 decimals

export const server = new rpc.Server(RPC_URL)
export const explorerTx = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`
export const explorerContract = (c: string) => `https://stellar.expert/explorer/testnet/contract/${c}`

// ---------------------------------------------------------------------------------------------
// ScVal helpers
// ---------------------------------------------------------------------------------------------
export const addr = (a: string) => new Address(a).toScVal()
export const i128 = (n: bigint) =>
  xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString((n >> 64n).toString()),
      lo: xdr.Uint64.fromString((n & 0xffff_ffff_ffff_ffffn).toString()),
    }),
  )
export const u32 = (n: number) => xdr.ScVal.scvU32(n)
export const u32Vec = (ids: number[]) => xdr.ScVal.scvVec(ids.map(i => xdr.ScVal.scvU32(i)))
export const str = (s: string) => xdr.ScVal.scvString(s)
const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const mapEntry = (key: xdr.ScVal, val: xdr.ScVal) => new xdr.ScMapEntry({ key, val })
/** Option<T>: Some(x) is the bare value, None is void. */
export const option = (v: xdr.ScVal | undefined) => v ?? xdr.ScVal.scvVoid()

/** `Signer::External(verifier, key_data)` */
export function externalSignerScVal(verifier: string, keyData: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvVec([sym('External'), addr(verifier), xdr.ScVal.scvBytes(Buffer.from(keyData))])
}

/** `ContextRuleType::CallContract(contract)` */
export const callContractRule = (contract: string) => xdr.ScVal.scvVec([sym('CallContract'), addr(contract)])
export const defaultRule = () => xdr.ScVal.scvVec([sym('Default')])

/** `SpendingLimitAccountParams { period_ledgers: u32, spending_limit: i128 }` (fields sorted). */
export function spendingLimitParams(spendingLimit: bigint, periodLedgers: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    mapEntry(sym('period_ledgers'), u32(periodLedgers)),
    mapEntry(sym('spending_limit'), i128(spendingLimit)),
  ])
}

/**
 * Host ordering for ScMap keys (Smart Account Kit `compareScVal`, simplified for our key shapes):
 * the host compares Vec/Bytes/Symbol element-wise by content, not by XDR bytes (XDR is length-prefixed).
 */
export function compareScVal(a: xdr.ScVal, b: xdr.ScVal): number {
  const at = a.switch().value
  const bt = b.switch().value
  if (at !== bt) return at < bt ? -1 : 1
  switch (a.switch().name) {
    case 'scvVec': {
      const av = a.vec() ?? []
      const bv = b.vec() ?? []
      for (let i = 0; i < Math.min(av.length, bv.length); i++) {
        const c = compareScVal(av[i]!, bv[i]!)
        if (c !== 0) return c
      }
      return av.length - bv.length
    }
    case 'scvSymbol':
      return Buffer.compare(Buffer.from(a.sym().toString()), Buffer.from(b.sym().toString()))
    case 'scvBytes':
      return Buffer.compare(Buffer.from(a.bytes()), Buffer.from(b.bytes()))
    case 'scvAddress':
      return Buffer.compare(a.address().toXDR(), b.address().toXDR())
    default:
      return Buffer.compare(a.toXDR(), b.toXDR())
  }
}

// ---------------------------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------------------------
/** A smart-account signer: its onchain identity and a function that signs the 32-byte auth digest. */
export interface SmartSigner {
  readonly label: string
  /** The `Signer` enum value as stored in the context rule. */
  readonly scVal: xdr.ScVal
  /** Returns the bytes placed in `AuthPayload.signers[scVal]`. */
  sign(digest: Buffer): Promise<Buffer>
}

/** Ed25519 signer: `External(ED25519_VERIFIER, 32-byte pubkey)`, signature = raw 64-byte ed25519 over the digest. */
export function ed25519Signer(kp: Keypair, label = `ed25519:${kp.publicKey().slice(0, 6)}`): SmartSigner {
  return {
    label,
    scVal: externalSignerScVal(ED25519_VERIFIER, kp.rawPublicKey()),
    sign: async digest => Buffer.from(kp.sign(digest)),
  }
}

/**
 * v0.7.x "legacy-concat" auth digest, which the deployed WASM 1b5f4534… checks:
 * sha256(signature_payload ‖ ScVal::Vec<u32>(context_rule_ids).to_xdr()).
 * (stellar-accounts v0.8.0 switched to sha256(AuthDigestPreimage{…}.to_xdr()); not deployed on testnet.)
 */
export function authDigest(signaturePayload: Buffer, ruleIds: number[]): Buffer {
  return hash(Buffer.concat([signaturePayload, u32Vec(ruleIds).toXDR()]))
}

/** `AuthPayload { context_rule_ids: Vec<u32>, signers: Map<Signer, Bytes> }`, signer map in host order. */
export function authPayloadScVal(ruleIds: number[], sigs: Array<[xdr.ScVal, Buffer]>): xdr.ScVal {
  const entries = sigs
    .map(([k, v]) => mapEntry(k, xdr.ScVal.scvBytes(v)))
    .sort((a, b) => compareScVal(a.key(), b.key()))
  return xdr.ScVal.scvMap([
    mapEntry(sym('context_rule_ids'), u32Vec(ruleIds)),
    mapEntry(sym('signers'), xdr.ScVal.scvMap(entries)),
  ])
}

/**
 * Authorize one smart-account auth entry with one or more signers under `ruleIds`
 * (one rule id per auth context; a SAC transfer or a self-admin call has exactly one context).
 */
export async function authorizeWithSigners(
  entry: xdr.SorobanAuthorizationEntry,
  signers: SmartSigner[],
  ruleIds: number[],
  validUntilLedger: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    entry,
    async (_preimage: xdr.HashIdPreimage, payload: Buffer) => {
      const digest = authDigest(payload, ruleIds)
      const sigs: Array<[xdr.ScVal, Buffer]> = []
      for (const s of signers) sigs.push([s.scVal, await s.sign(digest)])
      return { signatureScVal: authPayloadScVal(ruleIds, sigs) }
    },
    validUntilLedger,
    NETWORK_PASSPHRASE,
  )
}

export const authorizeWithEd25519 = (
  entry: xdr.SorobanAuthorizationEntry,
  kp: Keypair,
  ruleIds: number[],
  validUntilLedger: number,
) => authorizeWithSigners(entry, [ed25519Signer(kp)], ruleIds, validUntilLedger)

// ---------------------------------------------------------------------------------------------
// WebAuthn (secp256r1) — the shape a browser passkey produces and the WEBAUTHN_VERIFIER checks
// ---------------------------------------------------------------------------------------------
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')

/** DER ECDSA → 64-byte r‖s with low-s (what the verifier's secp256r1_verify needs). */
export function derToCompactLowS(der: Uint8Array): Buffer {
  const d = Buffer.from(der)
  if (d[0] !== 0x30) throw new Error('DER: no SEQUENCE')
  let o = 2
  if (d[o] !== 0x02) throw new Error('DER: no INTEGER r')
  const rLen = d[o + 1]!
  const r = BigInt('0x' + d.subarray(o + 2, o + 2 + rLen).toString('hex'))
  o = o + 2 + rLen
  if (d[o] !== 0x02) throw new Error('DER: no INTEGER s')
  const sLen = d[o + 1]!
  let s = BigInt('0x' + d.subarray(o + 2, o + 2 + sLen).toString('hex'))
  if (s > P256_N / 2n) s = P256_N - s
  const pad = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex')
  return Buffer.concat([pad(r), pad(s)])
}

/** What `navigator.credentials.get()` returns (AuthenticatorAssertionResponse), as raw bytes. */
export interface WebAuthnAssertion {
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  /** DER-encoded ECDSA signature, exactly as the browser returns it. */
  signature: Uint8Array
}

/** Bytes placed in AuthPayload.signers for a WebAuthn signer: XDR of ScMap {authenticator_data, client_data, signature}. */
export function webAuthnSignatureBytes(a: WebAuthnAssertion): Buffer {
  return xdr.ScVal.scvMap([
    mapEntry(sym('authenticator_data'), xdr.ScVal.scvBytes(Buffer.from(a.authenticatorData))),
    mapEntry(sym('client_data'), xdr.ScVal.scvBytes(Buffer.from(a.clientDataJSON))),
    mapEntry(sym('signature'), xdr.ScVal.scvBytes(derToCompactLowS(a.signature))),
  ]).toXDR()
}

/** `External(WEBAUTHN_VERIFIER, 65-byte uncompressed P-256 pubkey ‖ credential id)` */
export const webAuthnSignerScVal = (publicKey65: Uint8Array, credentialId: Uint8Array) =>
  externalSignerScVal(WEBAUTHN_VERIFIER, Buffer.concat([Buffer.from(publicKey65), Buffer.from(credentialId)]))

/**
 * Step 1 of the approval-page flow: fix the expiration and compute the digest the passkey must sign.
 * The browser calls navigator.credentials.get({ publicKey: { challenge: digest, … } }); the challenge
 * inside clientDataJSON is then base64url(digest), which is what the verifier compares.
 */
export function webAuthnChallenge(entry: xdr.SorobanAuthorizationEntry, ruleIds: number[], validUntilLedger: number) {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
  const creds = clone.credentials()
  const ac = creds.switch().name === 'sorobanCredentialsAddressV2' ? creds.addressV2() : creds.address()
  ac.signatureExpirationLedger(validUntilLedger)
  const preimage = buildPreimage(clone, validUntilLedger)
  const digest = authDigest(hash(preimage.toXDR()), ruleIds)
  return { digest, challengeB64url: b64url(digest) }
}

const buildPreimage = (e: xdr.SorobanAuthorizationEntry, until: number) =>
  buildAuthorizationEntryPreimage(e, until, NETWORK_PASSPHRASE)

/**
 * Step 2 of the approval-page flow: put a passkey assertion into the entry. `assertion` is what the
 * browser returned for the challenge from webAuthnChallenge(entry, ruleIds, validUntilLedger).
 */
export async function authorizeWithWebAuthn(
  entry: xdr.SorobanAuthorizationEntry,
  assertion: WebAuthnAssertion,
  opts: { signerScVal: xdr.ScVal; ruleIds: number[]; validUntilLedger: number },
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    entry,
    async (_pre: xdr.HashIdPreimage, payload: Buffer) => {
      const digest = authDigest(payload, opts.ruleIds)
      const client = JSON.parse(Buffer.from(assertion.clientDataJSON).toString('utf8')) as { challenge: string }
      if (client.challenge !== b64url(digest))
        throw new Error('clientDataJSON.challenge does not match the auth digest')
      return { signatureScVal: authPayloadScVal(opts.ruleIds, [[opts.signerScVal, webAuthnSignatureBytes(assertion)]]) }
    },
    opts.validUntilLedger,
    NETWORK_PASSPHRASE,
  )
}

/**
 * A software passkey for tests: P-256 key + the exact bytes a platform authenticator produces for
 * `navigator.credentials.get` (authenticatorData = rpIdHash ‖ flags(UP|UV) ‖ signCount,
 * clientDataJSON = {"type":"webauthn.get","challenge":b64url(digest),"origin":…}, DER signature
 * over authenticatorData ‖ sha256(clientDataJSON)).
 */
export class SoftPasskey {
  readonly privateKey: KeyObject
  readonly publicKey65: Buffer
  readonly credentialId: Buffer
  signCount = 0
  constructor(
    readonly rpId = 'localhost',
    readonly origin = 'http://localhost:5173',
    pkcs8Der?: Buffer,
    credentialId?: Buffer,
  ) {
    this.privateKey = pkcs8Der
      ? createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    const jwk = createPublicKey(this.privateKey).export({ format: 'jwk' }) as { x: string; y: string }
    this.publicKey65 = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ])
    this.credentialId = credentialId ?? randomBytes(16)
  }
  exportPkcs8(): Buffer {
    return this.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  }
  get scVal() {
    return webAuthnSignerScVal(this.publicKey65, this.credentialId)
  }
  /** Behaves like navigator.credentials.get({publicKey:{challenge, rpId, userVerification:"required"}}). */
  assert(challenge: Buffer): WebAuthnAssertion {
    const rpIdHash = createHash('sha256').update(this.rpId).digest()
    const flags = Buffer.from([0x05]) // UP (0x01) | UV (0x04)
    const count = Buffer.alloc(4)
    count.writeUInt32BE(++this.signCount)
    const authenticatorData = Buffer.concat([rpIdHash, flags, count])
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin: this.origin, crossOrigin: false }),
    )
    const signed = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()])
    const signature = nodeSign('sha256', signed, { key: this.privateKey, dsaEncoding: 'der' })
    return { authenticatorData, clientDataJSON, signature }
  }
  /** As a SmartSigner, so invokeAs can drive it end to end. */
  asSigner(label = 'webauthn'): SmartSigner {
    return { label, scVal: this.scVal, sign: async digest => webAuthnSignatureBytes(this.assert(digest)) }
  }
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------
export interface TxReport {
  label: string
  hash: string
  status: 'SUCCESS' | 'FAILED'
  ledger?: number
  /** stroops actually charged (TransactionResult.feeCharged) */
  feeCharged?: string
  /** stroops: envelope max fee and the Soroban resource fee declared in it */
  maxFee: string
  resourceFee: string
  /** milliseconds */
  timings: Record<string, number>
  returnValue?: unknown
  resultCode?: string
  diagnostic?: string
  /** credential types of the simulated auth entries (CAP-71 ADDRESS_V2 on protocol ≥ 28) */
  credentialTypes?: string
  explorer: string
}

export class InvokeError extends Error {
  constructor(
    readonly stage: 'simulate' | 'enforce-simulate' | 'send' | 'onchain',
    readonly detail: string,
    readonly report?: Partial<TxReport>,
  ) {
    super(`${stage}: ${detail}`)
  }
  /** e.g. "Error(Contract, #3221)" */
  get contractError(): string | undefined {
    return this.detail.match(/Error\(Contract, #\d+\)/)?.[0]
  }
}

const CLASSIC_FEE = '1000' // inclusion fee in stroops; resource fee comes from simulation
const now = () => performance.now()

function invokeFunc(contract: string, fn: string, args: xdr.ScVal[]) {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
  )
}

async function sendAndPoll(
  tx: ReturnType<TransactionBuilder['build']>,
  label: string,
  timings: Record<string, number>,
): Promise<TxReport> {
  const t0 = now()
  const sent = await server.sendTransaction(tx)
  const hashHex = sent.hash
  const base: Omit<TxReport, 'status'> = {
    label,
    hash: hashHex,
    maxFee: tx.fee,
    resourceFee: tx.toEnvelope().v1().tx().ext().value()?.resourceFee().toString() ?? '0',
    timings,
    explorer: explorerTx(hashHex),
  }
  if (sent.status === 'ERROR') {
    throw new InvokeError('send', sent.errorResult?.result().switch().name ?? 'ERROR', { ...base, status: 'FAILED' })
  }
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(1000)
    const r = await server.getTransaction(hashHex)
    if (r.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue
    timings.sendToFinal = Math.round(now() - t0)
    const report: TxReport = {
      ...base,
      status: r.status === rpc.Api.GetTransactionStatus.SUCCESS ? 'SUCCESS' : 'FAILED',
      ledger: r.ledger,
      feeCharged: r.resultXdr?.feeCharged().toString(),
      resultCode: r.resultXdr?.result().switch().name,
    }
    if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      report.returnValue = r.returnValue ? scValToNative(r.returnValue) : undefined
      return report
    }
    const errs = scErrors(r.diagnosticEventsXdr ?? [])
    report.diagnostic = `${report.resultCode}; ${opResultCode(r.resultXdr)}; ${errs.join(' | ') || 'no ScError in events'}`
    throw new InvokeError('onchain', report.diagnostic, report)
  }
  throw new InvokeError('send', `not final after 60 s: ${hashHex}`)
}

/** Pull every ScError out of diagnostic events, e.g. "Error(Contract, #3221)". */
export function scErrors(events: xdr.DiagnosticEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) {
    try {
      const body = ev.event().body().v0()
      for (const v of [...body.topics(), body.data()]) {
        if (v.switch().name !== 'scvError') continue
        const e = v.error()
        const kind = e.switch().name.replace(/^sce/, '')
        const code = kind === 'Contract' ? `#${e.contractCode()}` : e.code().name.replace(/^scec/, '')
        out.push(`Error(${kind}, ${code})`)
      }
    } catch {}
  }
  return [...new Set(out)]
}

function opResultCode(res: xdr.TransactionResult | undefined): string {
  try {
    const op = res?.result().results()?.[0]
    return op?.tr().invokeHostFunctionResult().switch().name ?? '?'
  } catch {
    return '?'
  }
}

const buildTx = (sponsor: Keypair, seq: string, op: xdr.Operation) =>
  new TransactionBuilder(new Account(sponsor.publicKey(), seq), {
    fee: CLASSIC_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(120)
    .build()

/** Read-only contract call via simulation (no signature, no fee). */
export async function view(source: string, contract: string, fn: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const acct = await server.getAccount(source)
  const tx = new TransactionBuilder(acct, { fee: CLASSIC_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func: invokeFunc(contract, fn, args), auth: [] }))
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (!rpc.Api.isSimulationSuccess(sim)) throw new InvokeError('simulate', sim.error)
  return sim.result ? scValToNative(sim.result.retval) : undefined
}

export interface PreparedInvocation {
  func: xdr.HostFunction
  seq: string
  /** unsigned auth entries from the record-mode simulation (C-account entries need signing) */
  entries: xdr.SorobanAuthorizationEntry[]
  validUntilLedger: number
  recordSim: rpc.Api.SimulateTransactionSuccessResponse
  timings: Record<string, number>
}

/** Step 1: build + record-mode simulate. Returns the unsigned entries the account must authorize. */
export async function prepareInvocation(
  sponsor: Keypair,
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  authValidForLedgers = 60,
): Promise<PreparedInvocation> {
  const timings: Record<string, number> = {}
  const func = invokeFunc(contract, fn, args)
  const seq = (await server.getAccount(sponsor.publicKey())).sequenceNumber()
  const t0 = now()
  const sim = await server.simulateTransaction(buildTx(sponsor, seq, Operation.invokeHostFunction({ func, auth: [] })))
  timings.recordSim = Math.round(now() - t0)
  if (!rpc.Api.isSimulationSuccess(sim)) throw new InvokeError('simulate', sim.error)
  const validUntilLedger = sim.latestLedger + authValidForLedgers
  return { func, seq, entries: sim.result?.auth ?? [], validUntilLedger, recordSim: sim, timings }
}

/** Step 3: enforce-mode simulate with the signed entries, assemble, sponsor signs, send, poll. */
export async function finalizeInvocation(
  sponsor: Keypair,
  prep: PreparedInvocation,
  signedEntries: xdr.SorobanAuthorizationEntry[],
  label: string,
  opts: { skipEnforceSim?: boolean; forceOnchainOnReject?: xdr.SorobanTransactionData } = {},
): Promise<TxReport> {
  const timings = prep.timings
  const signed = buildTx(sponsor, prep.seq, Operation.invokeHostFunction({ func: prep.func, auth: signedEntries }))
  let tx: ReturnType<TransactionBuilder['build']>
  if (opts.skipEnforceSim) {
    // Deliberately wrong path (to prove re-simulation is required): record-mode footprint + signed auth.
    tx = rpc.assembleTransaction(signed, prep.recordSim).build()
  } else {
    const t0 = now()
    const sim = await server.simulateTransaction(signed, undefined, 'enforce')
    timings.enforceSim = Math.round(now() - t0)
    if (!rpc.Api.isSimulationSuccess(sim)) {
      if (!opts.forceOnchainOnReject) throw new InvokeError('enforce-simulate', sim.error, { label, timings })
      // Submit anyway with a superset footprint so the rejection is recorded onchain (negative-test evidence).
      tx = withFootprint(signed, prep.recordSim, opts.forceOnchainOnReject)
      tx.sign(sponsor)
      try {
        return await sendAndPoll(tx, label, timings)
      } catch (e) {
        if (e instanceof InvokeError) (e as { simError?: string }).simError = sim.error
        throw e
      }
    }
    tx = rpc.assembleTransaction(signed, sim).build()
  }
  tx.sign(sponsor)
  return sendAndPoll(tx, label, timings)
}

/** The whole flow for one smart-account authorization: prepare → authorize → enforce-sim → send. */
export async function invokeAs(
  sponsor: Keypair,
  account: string,
  signers: SmartSigner[],
  ruleIds: number[],
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  opts: { label?: string; skipEnforceSim?: boolean; forceOnchainOnReject?: xdr.SorobanTransactionData } = {},
): Promise<TxReport & { sorobanData?: xdr.SorobanTransactionData }> {
  const label = opts.label ?? `${fn}`
  const prep = await prepareInvocation(sponsor, contract, fn, args)
  const t0 = now()
  const signedEntries = await Promise.all(
    prep.entries.map(async e => {
      if (e.credentials().switch().name === 'sorobanCredentialsSourceAccount') return e
      const creds = e.credentials()
      const ac = creds.switch().name === 'sorobanCredentialsAddressV2' ? creds.addressV2() : creds.address()
      const who = Address.fromScAddress(ac.address()).toString()
      if (who !== account) throw new Error(`unexpected auth entry for ${who}`)
      return authorizeWithSigners(e, signers, ruleIds, prep.validUntilLedger)
    }),
  )
  prep.timings.sign = Math.round(now() - t0)
  const credentialTypes = prep.entries.map(e => e.credentials().switch().name).join(',')
  try {
    const report = await finalizeInvocation(sponsor, prep, signedEntries, label, opts)
    return { ...report, credentialTypes }
  } catch (e) {
    if (e instanceof InvokeError) Object.assign(e, { credentialTypes })
    throw e
  }
}

/** Superset footprint: template's keys (minus its nonces) ∪ record-sim keys; resources = max × 1.5. */
function withFootprint(
  signed: ReturnType<TransactionBuilder['build']>,
  recordSim: rpc.Api.SimulateTransactionSuccessResponse,
  template: xdr.SorobanTransactionData,
) {
  const rec = recordSim.transactionData.build()
  const isNonce = (k: xdr.LedgerKey) =>
    k.switch().name === 'contractData' && k.contractData().key().switch().name === 'scvLedgerKeyNonce'
  const uniq = (keys: xdr.LedgerKey[]) => {
    const seen = new Map<string, xdr.LedgerKey>()
    for (const k of keys) seen.set(k.toXDR('base64'), k)
    return [...seen.values()]
  }
  const tf = template.resources().footprint()
  const rf = rec.resources().footprint()
  const readWrite = uniq([...tf.readWrite().filter(k => !isNonce(k)), ...rf.readWrite()])
  const rwSet = new Set(readWrite.map(k => k.toXDR('base64')))
  const readOnly = uniq([...tf.readOnly(), ...rf.readOnly()]).filter(k => !rwSet.has(k.toXDR('base64')))
  const tr = template.resources()
  const rr = rec.resources()
  const max15 = (a: number, b: number) => Math.ceil(Math.max(a, b) * 1.5)
  const data = new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly, readWrite }),
      instructions: max15(tr.instructions(), rr.instructions()),
      diskReadBytes: max15(tr.diskReadBytes(), rr.diskReadBytes()),
      writeBytes: max15(tr.writeBytes(), rr.writeBytes()),
    }),
    resourceFee: xdr.Int64.fromString(
      String(Math.ceil(Math.max(Number(template.resourceFee().toString()), Number(rec.resourceFee().toString())) * 2)),
    ),
  })
  const resourceFee = BigInt(data.resourceFee().toString())
  return TransactionBuilder.cloneFrom(signed, {
    fee: (BigInt(CLASSIC_FEE) + resourceFee).toString(),
    sorobanData: data,
    networkPassphrase: NETWORK_PASSPHRASE,
  }).build()
}

/** Enforce-simulate a successful invocation and return its SorobanTransactionData (used as a footprint template). */
export async function footprintTemplate(
  sponsor: Keypair,
  account: string,
  signers: SmartSigner[],
  ruleIds: number[],
  contract: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<xdr.SorobanTransactionData> {
  const prep = await prepareInvocation(sponsor, contract, fn, args)
  const signedEntries = await Promise.all(
    prep.entries.map(e => authorizeWithSigners(e, signers, ruleIds, prep.validUntilLedger)),
  )
  const signed = buildTx(sponsor, prep.seq, Operation.invokeHostFunction({ func: prep.func, auth: signedEntries }))
  const sim = await server.simulateTransaction(signed, undefined, 'enforce')
  if (!rpc.Api.isSimulationSuccess(sim)) throw new InvokeError('enforce-simulate', sim.error)
  return sim.transactionData.build()
}

// ---------------------------------------------------------------------------------------------
// Account lifecycle
// ---------------------------------------------------------------------------------------------
/** Deploy one account instance from the already-uploaded WASM with `owner` in rule 0 (Default); sponsor pays. */
export async function deployAccount(sponsor: Keypair, owner: SmartSigner): Promise<TxReport & { contractId: string }> {
  const timings: Record<string, number> = {}
  const op = Operation.createCustomContract({
    address: new Address(sponsor.publicKey()),
    wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
    salt: randomBytes(32),
    constructorArgs: [xdr.ScVal.scvVec([owner.scVal]), xdr.ScVal.scvMap([])],
  })
  const seq = (await server.getAccount(sponsor.publicKey())).sequenceNumber()
  const raw = buildTx(sponsor, seq, op)
  const t0 = now()
  const sim = await server.simulateTransaction(raw)
  timings.recordSim = Math.round(now() - t0)
  if (!rpc.Api.isSimulationSuccess(sim)) throw new InvokeError('simulate', sim.error)
  const contractId = scValToNative(sim.result!.retval) as string
  const tx = rpc.assembleTransaction(raw, sim).build()
  tx.sign(sponsor)
  const report = await sendAndPoll(tx, 'deploy account', timings)
  return { ...report, contractId }
}

/** Owner (rule 0) installs `CallContract(token)` + connection signer + spending-limit policy. Returns the new rule id. */
export async function addConnectionRule(
  sponsor: Keypair,
  account: string,
  owner: SmartSigner,
  p: {
    token: string
    connection: SmartSigner
    name: string
    spendingLimit: bigint
    periodLedgers: number
    validUntilLedger: number
  },
): Promise<TxReport & { ruleId: number }> {
  const policies = xdr.ScVal.scvMap([
    mapEntry(addr(SPENDING_LIMIT_POLICY), spendingLimitParams(p.spendingLimit, p.periodLedgers)),
  ])
  const r = await invokeAs(
    sponsor,
    account,
    [owner],
    [0],
    account,
    'add_context_rule',
    [
      callContractRule(p.token),
      str(p.name),
      option(u32(p.validUntilLedger)),
      xdr.ScVal.scvVec([p.connection.scVal]),
      policies,
    ],
    { label: `add_context_rule ${p.name}` },
  )
  const rule = r.returnValue as { id: number }
  return { ...r, ruleId: Number(rule.id) }
}

/** Owner (rule 0) removes a context rule (also uninstalls its policies). */
export const removeRule = (sponsor: Keypair, account: string, owner: SmartSigner, ruleId: number) =>
  invokeAs(sponsor, account, [owner], [0], account, 'remove_context_rule', [u32(ruleId)], {
    label: `remove_context_rule ${ruleId}`,
  })

/** Owner adds a signer to a rule (e.g. a passkey to rule 0). */
export const addSigner = (sponsor: Keypair, account: string, owner: SmartSigner, ruleId: number, signer: SmartSigner) =>
  invokeAs(sponsor, account, [owner], [0], account, 'add_signer', [u32(ruleId), signer.scVal], {
    label: `add_signer ${signer.label} → rule ${ruleId}`,
  })

/** USDC (or any SAC) transfer from the smart account, authorized by `signer` under `ruleId`. */
export const transferAs = (
  sponsor: Keypair,
  account: string,
  signer: SmartSigner,
  ruleId: number,
  to: string,
  amount: bigint,
  opts: {
    label?: string
    token?: string
    skipEnforceSim?: boolean
    forceOnchainOnReject?: xdr.SorobanTransactionData
  } = {},
) =>
  invokeAs(
    sponsor,
    account,
    [signer],
    [ruleId],
    opts.token ?? USDC_SAC,
    'transfer',
    [addr(account), addr(to), i128(amount)],
    {
      label: opts.label ?? `transfer ${amount} by ${signer.label} (rule ${ruleId})`,
      ...opts,
    },
  )

export interface SpendingLimitData {
  spending_limit: bigint
  period_ledgers: number
  cached_total_spent: bigint
  spending_history: Array<{ amount: bigint; ledger_sequence: number }>
}
/** Policy view: `get_spending_limit_data(context_rule_id, smart_account)`. */
export const readSpendingLimit = (source: string, account: string, ruleId: number) =>
  view(source, SPENDING_LIMIT_POLICY, 'get_spending_limit_data', [
    u32(ruleId),
    addr(account),
  ]) as Promise<SpendingLimitData>

export const tokenBalance = async (source: string, holder: string, token = USDC_SAC) =>
  (await view(source, token, 'balance', [addr(holder)])) as bigint

export const latestLedger = async () => (await server.getLatestLedger()).sequence

export const pubHex = (kp: Keypair) => Buffer.from(kp.rawPublicKey()).toString('hex')
export const isG = (s: string) => StrKey.isValidEd25519PublicKey(s)
