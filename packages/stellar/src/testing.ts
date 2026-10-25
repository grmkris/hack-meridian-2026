import type { OwnerPasskey, WebAuthnAssertion } from '@hm/protocol'

import { compactToDer } from './auth.ts'
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from './bytes.ts'

/**
 * A software passkey for tests and the rehearsal script: a WebCrypto P-256 key that answers
 * `navigator.credentials.get({ publicKey: { challenge, rpId, userVerification: 'required' } })` with the bytes a
 * platform authenticator returns (authenticatorData = rpIdHash ‖ flags UP|UV ‖ counter, DER signature over
 * authenticatorData ‖ sha256(clientDataJSON)). WebCrypto only, so it runs in Bun, Node and workerd.
 */
export class SoftPasskey {
  private counter = 0

  private constructor(
    private readonly privateKey: CryptoKey,
    readonly publicKey65: Uint8Array<ArrayBuffer>,
    readonly credentialId: Uint8Array<ArrayBuffer>,
    readonly rpId: string,
    readonly origin: string,
  ) {}

  static async create(rpId = 'localhost', origin = 'http://localhost:18960'): Promise<SoftPasskey> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    if (!('publicKey' in pair)) throw new TypeError('ECDSA generateKey returned a single key')
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
    if (!(raw instanceof ArrayBuffer)) throw new TypeError('raw export did not return bytes')
    return new SoftPasskey(
      pair.privateKey,
      new Uint8Array(raw),
      crypto.getRandomValues(new Uint8Array(16)),
      rpId,
      origin,
    )
  }

  /** Restore from `serialize()` (tests keep one passkey across runs in their .env). */
  static async restore(
    serialized: string,
    rpId = 'localhost',
    origin = 'http://localhost:18960',
  ): Promise<SoftPasskey> {
    const [jwkB64, credB64] = serialized.split('.')
    if (jwkB64 === undefined || credB64 === undefined) throw new RangeError('bad serialized passkey')
    const jwk: JsonWebKey = JSON.parse(new TextDecoder().decode(fromBase64Url(jwkB64)))
    const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    const { x, y } = jwk
    if (x === undefined || y === undefined) throw new RangeError('passkey JWK has no public point')
    const pub = concatBytes(Uint8Array.of(0x04), fromBase64Url(x), fromBase64Url(y))
    return new SoftPasskey(privateKey, pub, fromBase64Url(credB64), rpId, origin)
  }

  async serialize(): Promise<string> {
    const jwk = await crypto.subtle.exportKey('jwk', this.privateKey)
    if (jwk instanceof ArrayBuffer) throw new TypeError('jwk export returned bytes')
    return `${toBase64Url(utf8(JSON.stringify(jwk)))}.${toBase64Url(this.credentialId)}`
  }

  get owner(): OwnerPasskey {
    return { pubkey: this.publicKey65, credentialId: this.credentialId }
  }

  /** What the approval page's `navigator.credentials.get` returns for `challenge` (raw bytes, not base64url). */
  async assert(challenge: Uint8Array, flags = 0x05): Promise<WebAuthnAssertion> {
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(this.rpId)))
    this.counter += 1
    const count = new Uint8Array(4)
    new DataView(count.buffer).setUint32(0, this.counter)
    const authenticatorData = concatBytes(rpIdHash, Uint8Array.of(flags), count)
    const clientDataJSON = utf8(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: toBase64Url(challenge),
        origin: this.origin,
        crossOrigin: false,
      }),
    )
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON))
    const rs = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.privateKey,
        concatBytes(authenticatorData, clientHash),
      ),
    )
    return { authenticatorData, clientDataJSON, signature: compactToDer(rs) }
  }

  /** The same, for a base64url challenge as the prepared objects carry it. */
  assertChallenge(challenge: string): Promise<WebAuthnAssertion> {
    return this.assert(fromBase64Url(challenge))
  }
}
