import { xdr } from '@stellar/stellar-sdk'

/**
 * Byte helpers that work in Bun, Node and workerd with or without `nodejs_compat`.
 *
 * js-xdr checks `Buffer.isBuffer` on every opaque field, so bytes handed to the SDK must be instances of the Buffer
 * class the SDK itself imports: `node:buffer` where it exists, the bundled npm polyfill otherwise. We borrow that
 * class from a value the SDK produced instead of reading a global.
 */
const sample = xdr.ScVal.scvVoid().toXDR()
type SdkBuffer = typeof sample

interface BufferClass {
  from(array: ArrayBufferLike, byteOffset: number, length: number): SdkBuffer
}

/** `toXDR()` returns an instance of the SDK's Buffer class, and an instance's `constructor` is that class. */
const isBufferClass = (c: unknown): c is BufferClass =>
  typeof c === 'function' && 'from' in c && typeof c.from === 'function'

const sdkBufferClass = (): BufferClass => {
  const ctor: unknown = sample.constructor
  if (!isBufferClass(ctor)) throw new TypeError('the Stellar SDK did not produce a Buffer')
  return ctor
}
const SdkBufferClass = sdkBufferClass()

/** A view of `bytes` as the SDK's Buffer (no copy). */
export const toBuffer = (bytes: Uint8Array): SdkBuffer =>
  SdkBufferClass.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** A plain Uint8Array copy (what crosses the package boundary). */
export const toBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)

export const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s))
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b)

export const toHex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) throw new RangeError('fromHex: not a hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const toBase64 = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
export const fromBase64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(
    s
      .replace(/-/gu, '+')
      .replace(/_/gu, '/')
      .padEnd(Math.ceil(s.length / 4) * 4, '='),
  )
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export const toBase64Url = (b: Uint8Array): string =>
  toBase64(b).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
/** Accepts base64url and standard base64, padded or not. */
export const fromBase64Url = fromBase64
