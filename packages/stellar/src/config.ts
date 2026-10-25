import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'

import { ChainError } from '@hm/protocol'

import { missingFields, networkName, type NetworkParams, PRESETS } from './network.ts'

/**
 * Everything the chain package needs from its host. In the Worker these come from bindings and secrets (A1 provides
 * a ConfigProvider over them); in tests and scripts from `packages/stellar/.env`. Secrets stay `Redacted` until the
 * moment a key signs, inside this package.
 */
export interface SafetyCaps {
  /** Largest spending grant the consent page may install (stroops). */
  readonly maxGrantStroops: bigint
  /** Largest single owner-approved payment (stroops). */
  readonly maxOwnerPaymentStroops: bigint
  /** Largest x402 price the pocket will pay (stroops). */
  readonly maxX402PriceStroops: bigint
  /** Kill switch: when false, nothing that moves value or grants authority is signed. Revoke and sweep still run. */
  readonly paymentsEnabled: boolean
}

export interface ChainSettings {
  /** The network preset (`STELLAR_NETWORK`) with per-field overrides applied. */
  readonly network: NetworkParams
  /** One to three relayer `S…` secrets: transaction source and fee payer for everything. */
  readonly relayerSecrets: ReadonlyArray<Redacted.Redacted>
  /** Holds USDC for `fundNewWallet` (the judge path's auto-fund). */
  readonly treasurySecret: Option.Option<Redacted.Redacted>
  /** Any string with ≥ 128 bits of entropy; the AES-GCM key for connection keys is derived from it with HKDF. */
  readonly vaultKey: Redacted.Redacted
  readonly ozApiKey: Option.Option<Redacted.Redacted>
  /** The seeded demo recipient (Carol) for the claim link's `?demo=1` path; testnet only. */
  readonly demoRecipientSecret: Option.Option<Redacted.Redacted>
  /** Refuse to submit when the enforce simulation's fee is above this (stroops). Default: the network's. */
  readonly maxFeeStroops: bigint
  /** How long an owner's passkey auth stays valid between prepare and finalize (ledgers). Default 400 ≈ 33 min. */
  readonly ownerAuthLedgers: number
  /** TTL set on each new wallet's instance right after deploy (ledgers; 0 = leave the network minimum). */
  readonly walletTtlLedgers: number
  readonly caps: SafetyCaps
  /** The fetch used for x402 and MCP requests (`globalThis.fetch` bound in the Worker). */
  readonly fetch: typeof globalThis.fetch
}

export const DEFAULT_OWNER_AUTH_LEDGERS = 400
/** 30 days of 5 s ledgers. */
export const DEFAULT_WALLET_TTL_LEDGERS = 518_400
export const DEFAULT_CAPS = { maxGrantUsdc: '20', maxOwnerPaymentUsdc: '100', maxX402PriceUsdc: '1' } as const

/** "2.5" → 25_000_000n (7 decimals). */
export const usdcToStroops = (s: string): bigint => {
  const m = /^(\d{1,12})(?:\.(\d{1,7}))?$/u.exec(s.trim())
  if (m === null) throw new RangeError(`not a USDC amount: ${s}`)
  return BigInt(m[1] ?? '0') * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0'))
}

const secretList = (name: string) =>
  Config.Redacted(name).pipe(
    Config.map(r =>
      Redacted.value(r)
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => Redacted.make(s)),
    ),
  )

const optString = (name: string) => Config.option(Config.String(name))
const usdc = (name: string, fallback: string) =>
  Config.String(name).pipe(Config.withDefault(fallback), Config.map(usdcToStroops))

const or = (v: Option.Option<string>, fallback: string) => Option.getOrElse(v, () => fallback)

const big = (v: Option.Option<string>, fallback: bigint) => Option.match(v, { onNone: () => fallback, onSome: BigInt })

/**
 * The network: `STELLAR_NETWORK` (`testnet` default, or `pubnet`) picks a preset; each field can be overridden:
 * `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_RPC_URL`, `STELLAR_RPC_FALLBACK_URL`, `STELLAR_HORIZON_URL`,
 * `STELLAR_EXPLORER_URL`, `STELLAR_FRIENDBOT_URL` (`off` disables), `X402_NETWORK`, `ACCOUNT_WASM_HASH`,
 * `ED25519_VERIFIER_ID`, `WEBAUTHN_VERIFIER_ID`, `SPENDING_LIMIT_POLICY_ID`, `USDC_SAC_ID`, `USDC_ISSUER`,
 * `ONBOARD_ROUTER_ID`, `NATIVE_SAC_ID`, `X402_FACILITATOR_URL`, `X402_FALLBACK_FACILITATOR_URL`,
 * `FIRST_PULL_MAX_FEE_STROOPS`, `PULL_MAX_FEE_STROOPS`, `OWNER_MAX_FEE_STROOPS`.
 */
export const networkConfig = Effect.gen(function* () {
  const name = yield* Config.String('STELLAR_NETWORK').pipe(Config.withDefault('testnet'))
  const preset = Option.fromNullishOr(networkName(name)).pipe(Option.map(n => PRESETS[n]))
  if (Option.isNone(preset))
    return yield* new ChainError({ kind: 'unknown', message: `STELLAR_NETWORK=${name}: use testnet or pubnet` })
  const p = preset.value
  const o = yield* Config.all({
    passphrase: optString('STELLAR_NETWORK_PASSPHRASE'),
    rpcUrl: optString('STELLAR_RPC_URL'),
    rpcFallbackUrl: optString('STELLAR_RPC_FALLBACK_URL'),
    horizonUrl: optString('STELLAR_HORIZON_URL'),
    explorerBase: optString('STELLAR_EXPLORER_URL'),
    friendbotUrl: optString('STELLAR_FRIENDBOT_URL'),
    x402Network: optString('X402_NETWORK'),
    usdcIssuer: optString('USDC_ISSUER'),
    accountWasmHash: optString('ACCOUNT_WASM_HASH'),
    ed25519Verifier: optString('ED25519_VERIFIER_ID'),
    webauthnVerifier: optString('WEBAUTHN_VERIFIER_ID'),
    spendingLimitPolicy: optString('SPENDING_LIMIT_POLICY_ID'),
    usdcSac: optString('USDC_SAC_ID'),
    onboardRouter: optString('ONBOARD_ROUTER_ID'),
    nativeSac: optString('NATIVE_SAC_ID'),
    facilitatorUrl: optString('X402_FACILITATOR_URL'),
    fallbackFacilitatorUrl: optString('X402_FALLBACK_FACILITATOR_URL'),
    maxFee: optString('MAX_FEE_STROOPS'),
    firstPullMaxFee: optString('FIRST_PULL_MAX_FEE_STROOPS'),
    pullMaxFee: optString('PULL_MAX_FEE_STROOPS'),
    ownerMaxFee: optString('OWNER_MAX_FEE_STROOPS'),
  })
  const friendbot = Option.getOrUndefined(o.friendbotUrl)
  const network: NetworkParams = {
    name: p.name,
    passphrase: or(o.passphrase, p.passphrase),
    rpcUrl: or(o.rpcUrl, p.rpcUrl),
    rpcFallbackUrl: Option.getOrElse(o.rpcFallbackUrl, () => p.rpcFallbackUrl),
    horizonUrl: or(o.horizonUrl, p.horizonUrl),
    explorerBase: or(o.explorerBase, p.explorerBase).replace(/\/$/u, ''),
    friendbotUrl: friendbot === 'off' ? null : (friendbot ?? p.friendbotUrl),
    x402Network: or(o.x402Network, p.x402Network),
    usdcIssuer: or(o.usdcIssuer, p.usdcIssuer),
    contracts: {
      accountWasmHash: or(o.accountWasmHash, p.contracts.accountWasmHash),
      ed25519Verifier: or(o.ed25519Verifier, p.contracts.ed25519Verifier),
      webauthnVerifier: or(o.webauthnVerifier, p.contracts.webauthnVerifier),
      spendingLimitPolicy: or(o.spendingLimitPolicy, p.contracts.spendingLimitPolicy),
      usdcSac: or(o.usdcSac, p.contracts.usdcSac),
      onboardRouter: or(o.onboardRouter, p.contracts.onboardRouter),
      nativeSac: or(o.nativeSac, p.contracts.nativeSac),
    },
    facilitatorUrl: or(o.facilitatorUrl, p.facilitatorUrl),
    fallbackFacilitatorUrl: or(o.fallbackFacilitatorUrl, p.fallbackFacilitatorUrl),
    fees: {
      maxFeeStroops: big(o.maxFee, p.fees.maxFeeStroops),
      firstPullMaxFeeStroops: big(o.firstPullMaxFee, p.fees.firstPullMaxFeeStroops),
      pullMaxFeeStroops: big(o.pullMaxFee, p.fees.pullMaxFeeStroops),
      ownerMaxFeeStroops: big(o.ownerMaxFee, p.fees.ownerMaxFeeStroops),
    },
  }
  const missing = missingFields(network)
  if (missing.length > 0)
    return yield* new ChainError({
      kind: 'unknown',
      message: `STELLAR_NETWORK=${network.name} is missing: ${missing.join(', ')}`,
    })
  return network
})

/**
 * Secrets and switches: `RELAYER_SECRET` (comma-separated, or `RELAYER_SECRETS`), `TREASURY_SECRET`, `VAULT_KEY`,
 * `OZ_FACILITATOR_KEY` (or `OZ_CHANNELS_API_KEY`), `DEMO_RECIPIENT_SECRET`, `OWNER_AUTH_LEDGERS`,
 * `WALLET_TTL_LEDGERS`, and the caps `MAX_GRANT_USDC` (20), `MAX_OWNER_PAYMENT_USDC` (100), `MAX_X402_PRICE_USDC`
 * (1), `PAYMENTS_ENABLED` (true).
 */
export const chainSettingsConfig = Effect.gen(function* () {
  const network = yield* networkConfig
  const s = yield* Config.all({
    relayerSecrets: secretList('RELAYER_SECRETS').pipe(Config.orElse(() => secretList('RELAYER_SECRET'))),
    treasurySecret: Config.option(Config.Redacted('TREASURY_SECRET')),
    vaultKey: Config.Redacted('VAULT_KEY'),
    ozApiKey: Config.option(
      Config.Redacted('OZ_FACILITATOR_KEY').pipe(Config.orElse(() => Config.Redacted('OZ_CHANNELS_API_KEY'))),
    ),
    demoRecipientSecret: Config.option(Config.Redacted('DEMO_RECIPIENT_SECRET')),
    ownerAuthLedgers: Config.Int('OWNER_AUTH_LEDGERS').pipe(Config.withDefault(DEFAULT_OWNER_AUTH_LEDGERS)),
    walletTtlLedgers: Config.Int('WALLET_TTL_LEDGERS').pipe(Config.withDefault(DEFAULT_WALLET_TTL_LEDGERS)),
    maxGrantStroops: usdc('MAX_GRANT_USDC', DEFAULT_CAPS.maxGrantUsdc),
    maxOwnerPaymentStroops: usdc('MAX_OWNER_PAYMENT_USDC', DEFAULT_CAPS.maxOwnerPaymentUsdc),
    maxX402PriceStroops: usdc('MAX_X402_PRICE_USDC', DEFAULT_CAPS.maxX402PriceUsdc),
    paymentsEnabled: Config.Boolean('PAYMENTS_ENABLED').pipe(Config.withDefault(true)),
  })
  if (s.relayerSecrets.length === 0)
    return yield* new ChainError({ kind: 'unknown', message: 'RELAYER_SECRET is empty' })
  return {
    network,
    relayerSecrets: s.relayerSecrets,
    treasurySecret: s.treasurySecret,
    vaultKey: s.vaultKey,
    ozApiKey: s.ozApiKey,
    demoRecipientSecret: s.demoRecipientSecret,
    maxFeeStroops: network.fees.maxFeeStroops,
    ownerAuthLedgers: s.ownerAuthLedgers,
    walletTtlLedgers: s.walletTtlLedgers,
    caps: {
      maxGrantStroops: s.maxGrantStroops,
      maxOwnerPaymentStroops: s.maxOwnerPaymentStroops,
      maxX402PriceStroops: s.maxX402PriceStroops,
      paymentsEnabled: s.paymentsEnabled,
    },
  }
})

export class ChainConfig extends Context.Service<ChainConfig, ChainSettings>()('hm/stellar/ChainConfig') {
  /** Settings from the ambient ConfigProvider (Worker bindings, or env in scripts). */
  static readonly fromConfig = (fetchImpl: typeof globalThis.fetch) =>
    Layer.effect(
      ChainConfig,
      Effect.map(chainSettingsConfig, settings => ChainConfig.of({ ...settings, fetch: fetchImpl })),
    )

  static readonly layer = (settings: ChainSettings) => Layer.succeed(ChainConfig, ChainConfig.of(settings))
}
