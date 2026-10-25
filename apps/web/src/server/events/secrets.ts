import { Effect, Option, Redacted } from 'effect'

import { McpEventError } from './errors.ts'

/**
 * Webhook secrets at rest: AES-256-GCM under a key derived from `VAULT_KEY` with HKDF-SHA256 (info
 * `nod/event-webhook-secret/v1`; the pattern of packages/stellar/src/vault.ts), the subscription id as additional
 * data so a sealed secret cannot be moved to another subscription. `ev1.<base64url(iv ‖ ciphertext)>`. A stage without
 * `VAULT_KEY` (the fixture chain: local dev, tests) uses a fixed development key: nothing of value is sealed there.
 */

const PREFIX = 'ev1'
const IV_BYTES = 12
const DEV_KEY = 'fixture-stage webhook key, not a secret'
const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '')
const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/gu, '+').replace(/_/gu, '/')), unit => unit.charCodeAt(0))

const deriveKey = async (vaultKey: string) => {
  const base = await crypto.subtle.importKey('raw', encoder.encode(vaultKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('nod/events'),
      info: encoder.encode('nod/event-webhook-secret/v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const keyText = (vaultKey: Option.Option<Redacted.Redacted>) =>
  Option.match(vaultKey, { onNone: () => DEV_KEY, onSome: Redacted.value })

const failure = () => new McpEventError({ reason: 'invalid_params' })

export const sealEventSecret = (vaultKey: Option.Option<Redacted.Redacted>, secret: string, subscriptionId: string) =>
  Effect.tryPromise({
    try: async () => {
      const key = await deriveKey(keyText(vaultKey))
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(subscriptionId) },
          key,
          encoder.encode(secret),
        ),
      )
      const blob = new Uint8Array(iv.length + sealed.length)
      blob.set(iv)
      blob.set(sealed, iv.length)
      return `${PREFIX}.${toBase64Url(blob)}`
    },
    catch: failure,
  })

export const openEventSecret = (vaultKey: Option.Option<Redacted.Redacted>, sealed: string, subscriptionId: string) =>
  Effect.tryPromise({
    try: async () => {
      const [prefix, blob, ...rest] = sealed.split('.')
      if (prefix !== PREFIX || blob === undefined || rest.length > 0) throw new Error('malformed sealed secret')
      const bytes = fromBase64Url(blob)
      const key = await deriveKey(keyText(vaultKey))
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(subscriptionId) },
        key,
        bytes.slice(IV_BYTES),
      )
      return new TextDecoder().decode(plain)
    },
    catch: failure,
  })
