import { describe, expect, it } from 'vitest'

import { Address, hash, Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk'

import { fromBase64Url, fromUtf8, toBase64, toBase64Url, toHex, utf8 } from '../src/bytes.ts'
import {
  authDigest,
  authorizeWithEd25519,
  authorizeWithWebAuthn,
  ChallengeMismatch,
  compactToDer,
  derToCompactLowS,
  ED25519_VERIFIER,
  entryAddress,
  entryRootCall,
  USDC_SAC,
  webAuthnChallenge,
  webAuthnSignatureBytes,
} from '../src/index.ts'
import { externalSigner } from '../src/scval.ts'
import { SoftPasskey } from '../src/testing.ts'
import fixtures from './fixtures/onchain-auth.json'

const entryOf = (b64: string) => xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64')
const mapField = (map: xdr.ScVal, name: string) =>
  (map.map() ?? []).find(e => e.key().switch().name === 'scvSymbol' && e.key().sym().toString() === name)?.val()

/** The AuthPayload in a signed smart-account entry: rule ids and the (signer, sig bytes) pairs. */
const authPayload = (entry: xdr.SorobanAuthorizationEntry) => {
  const sig = entry.credentials().address().signature()
  const ruleIds = (mapField(sig, 'context_rule_ids')?.vec() ?? []).map(v => v.u32())
  const signers = (mapField(sig, 'signers')?.map() ?? []).map(e => ({
    signer: e.key(),
    bytes: new Uint8Array(e.val().bytes()),
  }))
  return { ruleIds, signers }
}

describe('digest bytes against transactions that succeeded onchain (docs/spikes/s1.md)', () => {
  it('WebAuthn: our challenge equals the one the passkey signed in e5332a24 (owner 1 USDC transfer)', () => {
    const entry = entryOf(fixtures.webauthnTransfer.auth[0] ?? '')
    const { ruleIds, signers } = authPayload(entry)
    expect(ruleIds).toEqual([0])
    const until = entry.credentials().address().signatureExpirationLedger()
    const { challenge, digest } = webAuthnChallenge(entry, ruleIds, until, Networks.TESTNET)
    const sigMap = xdr.ScVal.fromXDR(Buffer.from(signers[0]?.bytes ?? []))
    const clientData = JSON.parse(fromUtf8(new Uint8Array(mapField(sigMap, 'client_data')?.bytes() ?? [])))
    expect(clientData.challenge).toBe(challenge)
    expect(digest).toHaveLength(32)
    expect(entryAddress(entry)).toBe('CAMYLBER4PRTYFDYMOUP7PYPSRNN7ZKNFPEMU643LWK4E2EXOWYTN34J')
    expect(entryRootCall(entry)?.fn).toBe('transfer')
  })

  it('Ed25519: the connection signature in 0122f487 (pocket pull) verifies over our digest', () => {
    const entry = entryOf(fixtures.ed25519Pull.auth[0] ?? '')
    const { ruleIds, signers } = authPayload(entry)
    expect(ruleIds).toEqual([3])
    const until = entry.credentials().address().signatureExpirationLedger()
    const { digest } = webAuthnChallenge(entry, ruleIds, until, Networks.TESTNET)
    const signer = signers[0]?.signer.vec() ?? []
    expect(Address.fromScVal(signer[1] ?? xdr.ScVal.scvVoid()).toString()).toBe(ED25519_VERIFIER)
    const conn = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(signer[2]?.bytes() ?? [])))
    expect(conn.publicKey()).toBe('GCEM4WKCAWO6ZZAA7SSSTG4SQWLRAI36ZM45QT7QHCPO6SB5ZLVLDH4K')
    expect(conn.verify(Buffer.from(digest), Buffer.from(signers[0]?.bytes ?? []))).toBe(true)
  })
})

describe('authorize with a connection key', () => {
  it('fills AuthPayload { context_rule_ids, signers: { External(ED25519, K): sig(digest) } }', async () => {
    const signed = entryOf(fixtures.ed25519Pull.auth[0] ?? '')
    const unsigned = xdr.SorobanAuthorizationEntry.fromXDR(signed.toXDR())
    unsigned.credentials().address().signature(xdr.ScVal.scvVoid())
    const k = Keypair.random()
    const out = await authorizeWithEd25519(unsigned, k, [7], 5_400_000, Networks.TESTNET, ED25519_VERIFIER)
    const { ruleIds, signers } = authPayload(out)
    expect(ruleIds).toEqual([7])
    expect(signers).toHaveLength(1)
    expect(signers[0]?.signer.toXDR('base64')).toBe(externalSigner(ED25519_VERIFIER, k.rawPublicKey()).toXDR('base64'))
    const { digest } = webAuthnChallenge(out, [7], 5_400_000, Networks.TESTNET)
    expect(k.verify(Buffer.from(digest), Buffer.from(signers[0]?.bytes ?? []))).toBe(true)
    expect(out.credentials().address().signatureExpirationLedger()).toBe(5_400_000)
  })
})

describe('WebAuthn signature shape', () => {
  // spikes/s1/out/webauthn-run1.txt, "approval-page wire payload"
  const wire = {
    authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ',
    clientDataJSON:
      '{"type":"webauthn.get","challenge":"Ierqo5jlzaTDVDcaextzD6iqOYVO2Pm1Dz4IfRcUHOI","origin":"http://localhost:5173","crossOrigin":false}',
    signatureDER: 'MEUCIBf9ga1hL3hb47VYCsMRKggtpiarQ65AdWpPYAcN95vjAiEAnbXYZZUPB69vW4K7-ukoRS2X_3NWiCLFMRE5MXNOUms',
    sigDataXdrBase64:
      'AAAAEQAAAAEAAAADAAAADwAAABJhdXRoZW50aWNhdG9yX2RhdGEAAAAAAA0AAAAlSZYN5YgOjGh0NBcPZHZgW4/krrmihjLHmVzzuoMdl2MFAAAAAQAAAAAAAA8AAAALY2xpZW50X2RhdGEAAAAADQAAAIZ7InR5cGUiOiJ3ZWJhdXRobi5nZXQiLCJjaGFsbGVuZ2UiOiJJZXJxbzVqbHphVERWRGNhZXh0ekQ2aXFPWVZPMlBtMUR6NElmUmNVSE9JIiwib3JpZ2luIjoiaHR0cDovL2xvY2FsaG9zdDo1MTczIiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQAAAAAADwAAAAlzaWduYXR1cmUAAAAAAAANAAAAQBf9ga1hL3hb47VYCsMRKggtpiarQ65AdWpPYAcN95vjYkonmWrw+FGQpH1EBRbXuo9O+zpQj3u/wqiRkYkU0uY=',
  }

  it('matches the recorded wire payload byte for byte (DER → low-s r‖s)', () => {
    const bytes = webAuthnSignatureBytes({
      authenticatorData: fromBase64Url(wire.authenticatorData),
      clientDataJSON: utf8(wire.clientDataJSON),
      signature: fromBase64Url(wire.signatureDER),
    })
    expect(toBase64(bytes)).toBe(wire.sigDataXdrBase64)
  })

  it('normalizes high-s and round-trips through DER', () => {
    const der = fromBase64Url(wire.signatureDER)
    const compact = derToCompactLowS(der)
    expect(compact).toHaveLength(64)
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
    expect(BigInt(`0x${toHex(compact.subarray(32))}`) <= n / 2n).toBe(true)
    expect(derToCompactLowS(compactToDer(compact))).toEqual(compact)
  })

  it('a software passkey assertion over the challenge authorizes; another challenge is refused locally', async () => {
    const passkey = await SoftPasskey.create()
    const signed = entryOf(fixtures.webauthnTransfer.auth[0] ?? '')
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(signed.toXDR())
    entry.credentials().address().signature(xdr.ScVal.scvVoid())
    const signerScVal = externalSigner(
      'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F',
      new Uint8Array([...passkey.publicKey65, ...passkey.credentialId]),
    )
    const { digest, challenge } = webAuthnChallenge(entry, [0], 5_400_000, Networks.TESTNET)
    const assertion = await passkey.assertChallenge(challenge)
    expect(fromUtf8(assertion.clientDataJSON)).toContain(challenge)
    const out = await authorizeWithWebAuthn(entry, assertion, {
      signerScVal,
      ruleIds: [0],
      validUntilLedger: 5_400_000,
      networkPassphrase: Networks.TESTNET,
    })
    expect(authPayload(out).signers[0]?.signer.toXDR('base64')).toBe(signerScVal.toXDR('base64'))
    // The signature verifies like the onchain verifier: secp256r1 over authenticatorData ‖ sha256(clientDataJSON).
    const key = await crypto.subtle.importKey(
      'raw',
      passkey.publicKey65,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const signedData = new Uint8Array([...assertion.authenticatorData, ...hash(Buffer.from(assertion.clientDataJSON))])
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      derToCompactLowS(assertion.signature),
      signedData,
    )
    expect(ok).toBe(true)
    expect(toBase64Url(digest)).toBe(challenge)

    const other = await passkey.assertChallenge(toBase64Url(new Uint8Array(32)))
    await expect(
      authorizeWithWebAuthn(entry, other, {
        signerScVal,
        ruleIds: [0],
        validUntilLedger: 5_400_000,
        networkPassphrase: Networks.TESTNET,
      }),
    ).rejects.toBeInstanceOf(ChallengeMismatch)
  })

  it('authDigest is sha256(payload ‖ Vec<u32>(ruleIds).toXDR())', () => {
    const payload = new Uint8Array(32).fill(7)
    const vec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]).toXDR()
    expect(authDigest(payload, [0])).toEqual(new Uint8Array(hash(Buffer.concat([Buffer.from(payload), vec]))))
    expect(entryRootCall(entryOf(fixtures.ed25519Pull.auth[0] ?? ''))?.contract).toBe(USDC_SAC)
  })
})
