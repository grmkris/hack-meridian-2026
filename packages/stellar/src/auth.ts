import { Schema } from 'effect'

import { Address, authorizeEntry, buildAuthorizationEntryPreimage, hash, Keypair, xdr } from '@stellar/stellar-sdk'

import { concatBytes, fromHex, fromUtf8, toBase64Url, toBuffer, toHex } from './bytes.ts'
import { bytes, compareScVal, externalSigner, mapEntry, sym, u32Vec } from './scval.ts'

/**
 * Authorizing a smart-account auth entry (spike S1, `spikes/s1/src/signer.ts`), pure and runtime-neutral.
 *
 * The deployed account WASM `1b5f4534…` checks the v0.7.x "legacy-concat" digest
 * `sha256(signature_payload ‖ ScVal::Vec<u32>(context_rule_ids).toXDR())`, where `signature_payload` is
 * `sha256(HashIdPreimage(entry, expiration))`, and expects the credentials' signature to be
 * `AuthPayload { context_rule_ids, signers: Map<Signer, Bytes> }` with the signer map in host order.
 */

/** A smart-account signer: its onchain `Signer` value and a function that signs the 32-byte auth digest. */
export interface SmartSigner {
  /** The `Signer` enum value as stored in the context rule. */
  readonly scVal: xdr.ScVal
  /** The bytes placed in `AuthPayload.signers[scVal]`. */
  readonly sign: (digest: Uint8Array) => Promise<Uint8Array>
}

/** What `navigator.credentials.get()` returns (AuthenticatorAssertionResponse), as raw bytes; signature in DER. */
export interface WebAuthnAssertion {
  readonly authenticatorData: Uint8Array
  readonly clientDataJSON: Uint8Array
  readonly signature: Uint8Array
}

export const authDigest = (signaturePayload: Uint8Array, ruleIds: ReadonlyArray<number>): Uint8Array =>
  new Uint8Array(hash(toBuffer(concatBytes(signaturePayload, u32Vec(ruleIds).toXDR()))))

export const authPayloadScVal = (
  ruleIds: ReadonlyArray<number>,
  sigs: ReadonlyArray<readonly [xdr.ScVal, Uint8Array]>,
): xdr.ScVal => {
  const entries = sigs.map(([k, v]) => mapEntry(k, bytes(v))).toSorted((a, b) => compareScVal(a.key(), b.key()))
  return xdr.ScVal.scvMap([
    mapEntry(sym('context_rule_ids'), u32Vec(ruleIds)),
    mapEntry(sym('signers'), xdr.ScVal.scvMap(entries)),
  ])
}

/** `External(verifier, 32-byte pubkey)`; the signature is the raw 64-byte Ed25519 signature over the digest. */
export const ed25519Signer = (kp: Keypair, verifier: string): SmartSigner => ({
  scVal: externalSigner(verifier, kp.rawPublicKey()),
  sign: digest => Promise.resolve(new Uint8Array(kp.sign(toBuffer(digest)))),
})

/** `External(webauthnVerifier, 65-byte uncompressed P-256 pubkey ‖ credential id)` */
export const webAuthnSignerScVal = (publicKey65: Uint8Array, credentialId: Uint8Array, verifier: string): xdr.ScVal =>
  externalSigner(verifier, concatBytes(publicKey65, credentialId))

/** Authorize one smart-account entry with signers under `ruleIds` (one rule id per auth context). */
export const authorizeWithSigners = (
  entry: xdr.SorobanAuthorizationEntry,
  signers: ReadonlyArray<SmartSigner>,
  ruleIds: ReadonlyArray<number>,
  validUntilLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> =>
  authorizeEntry(
    entry,
    async (_preimage, payload) => {
      const digest = authDigest(payload, ruleIds)
      const sigs: Array<readonly [xdr.ScVal, Uint8Array]> = []
      for (const s of signers) sigs.push([s.scVal, await s.sign(digest)])
      return { signatureScVal: authPayloadScVal(ruleIds, sigs) }
    },
    validUntilLedger,
    networkPassphrase,
  )

export const authorizeWithEd25519 = (
  entry: xdr.SorobanAuthorizationEntry,
  kp: Keypair,
  ruleIds: ReadonlyArray<number>,
  validUntilLedger: number,
  networkPassphrase: string,
  verifier: string,
): Promise<xdr.SorobanAuthorizationEntry> =>
  authorizeWithSigners(entry, [ed25519Signer(kp, verifier)], ruleIds, validUntilLedger, networkPassphrase)

const addressCredentials = (entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials => {
  const creds = entry.credentials()
  return creds.switch().name === 'sorobanCredentialsAddressV2' ? creds.addressV2() : creds.address()
}

/**
 * The digest the owner's passkey signs for `entry` (step 1 of the approval flow). The page passes it as the WebAuthn
 * challenge; the browser writes `base64url(digest)` into `clientDataJSON.challenge`, which the verifier compares.
 */
export const webAuthnChallenge = (
  entry: xdr.SorobanAuthorizationEntry,
  ruleIds: ReadonlyArray<number>,
  validUntilLedger: number,
  networkPassphrase: string,
): { readonly digest: Uint8Array; readonly challenge: string } => {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
  addressCredentials(clone).signatureExpirationLedger(validUntilLedger)
  const preimage = buildAuthorizationEntryPreimage(clone, validUntilLedger, networkPassphrase)
  const digest = authDigest(hash(preimage.toXDR()), ruleIds)
  return { digest, challenge: toBase64Url(digest) }
}

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const toBig = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt(`0x${toHex(b)}`))
const to32 = (n: bigint): Uint8Array<ArrayBuffer> => fromHex(n.toString(16).padStart(64, '0'))

/** DER ECDSA (what browsers return) → 64-byte `r‖s` with low-s (what `secp256r1_verify` accepts). */
export const derToCompactLowS = (der: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (der[0] !== 0x30) throw new RangeError('DER signature: no SEQUENCE')
  let o = der[1] === 0x81 ? 3 : 2
  if (der[o] !== 0x02) throw new RangeError('DER signature: no INTEGER r')
  const rLen = der[o + 1] ?? 0
  const r = toBig(der.subarray(o + 2, o + 2 + rLen))
  o = o + 2 + rLen
  if (der[o] !== 0x02) throw new RangeError('DER signature: no INTEGER s')
  const sLen = der[o + 1] ?? 0
  let s = toBig(der.subarray(o + 2, o + 2 + sLen))
  if (s > P256_N / 2n) s = P256_N - s
  return concatBytes(to32(r), to32(s))
}

/** Raw `r‖s` (WebCrypto's ECDSA output) → DER, the shape a browser assertion carries. */
const derInt = (b: Uint8Array): Uint8Array => {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  const v = b.subarray(i)
  return (v[0] ?? 0) & 0x80
    ? concatBytes(Uint8Array.of(0x02, v.length + 1, 0), v)
    : concatBytes(Uint8Array.of(0x02, v.length), v)
}

export const compactToDer = (rs: Uint8Array): Uint8Array<ArrayBuffer> => {
  const body = concatBytes(derInt(rs.subarray(0, 32)), derInt(rs.subarray(32, 64)))
  return concatBytes(Uint8Array.of(0x30, body.length), body)
}

/** The bytes in `AuthPayload.signers` for a WebAuthn signer: XDR of `{authenticator_data, client_data, signature}`. */
export const webAuthnSignatureBytes = (a: WebAuthnAssertion): Uint8Array =>
  new Uint8Array(
    xdr.ScVal.scvMap([
      mapEntry(sym('authenticator_data'), bytes(a.authenticatorData)),
      mapEntry(sym('client_data'), bytes(a.clientDataJSON)),
      mapEntry(sym('signature'), bytes(derToCompactLowS(a.signature))),
    ]).toXDR(),
  )

/** A passkey assertion made over a different challenge than this entry's digest. */
export class ChallengeMismatch extends Schema.TaggedError<ChallengeMismatch>()('ChallengeMismatch', {
  message: Schema.String,
}) {}

const clientChallenge = (clientDataJSON: Uint8Array): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(fromUtf8(clientDataJSON))
    if (typeof parsed === 'object' && parsed !== null && 'challenge' in parsed && typeof parsed.challenge === 'string')
      return parsed.challenge
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Step 2 of the approval flow: put the owner's passkey assertion into the entry. Checks locally that the assertion's
 * challenge is this entry's digest, so a mismatch never reaches the network.
 */
export const authorizeWithWebAuthn = (
  entry: xdr.SorobanAuthorizationEntry,
  assertion: WebAuthnAssertion,
  opts: {
    readonly signerScVal: xdr.ScVal
    readonly ruleIds: ReadonlyArray<number>
    readonly validUntilLedger: number
    readonly networkPassphrase: string
  },
): Promise<xdr.SorobanAuthorizationEntry> =>
  authorizeEntry(
    entry,
    (_preimage, payload) => {
      const digest = authDigest(payload, opts.ruleIds)
      if (clientChallenge(assertion.clientDataJSON) !== toBase64Url(digest))
        return Promise.reject(
          new ChallengeMismatch({ message: 'clientDataJSON.challenge does not match the auth digest' }),
        )
      return Promise.resolve({
        signatureScVal: authPayloadScVal(opts.ruleIds, [[opts.signerScVal, webAuthnSignatureBytes(assertion)]]),
      })
    },
    opts.validUntilLedger,
    opts.networkPassphrase,
  )

/** Who an auth entry is for (`G…`/`C…`), or undefined for source-account credentials. */
export const entryAddress = (entry: xdr.SorobanAuthorizationEntry): string | undefined => {
  const kind = entry.credentials().switch().name
  if (kind === 'sorobanCredentialsSourceAccount') return undefined
  return Address.fromScAddress(addressCredentials(entry).address()).toString()
}

/** The root call an entry authorizes, e.g. `{ contract: 'CBIE…', fn: 'transfer' }`. */
export const entryRootCall = (
  entry: xdr.SorobanAuthorizationEntry,
): { readonly contract: string; readonly fn: string; readonly args: ReadonlyArray<xdr.ScVal> } | undefined => {
  const fn = entry.rootInvocation().function()
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') return undefined
  const c = fn.contractFn()
  return {
    contract: Address.fromScAddress(c.contractAddress()).toString(),
    fn: c.functionName().toString(),
    args: c.args(),
  }
}
