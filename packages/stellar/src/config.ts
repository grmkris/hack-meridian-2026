import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'

import { HOSTED_FACILITATOR_URL, OZ_FACILITATOR_URL, TESTNET_PASSPHRASE, TESTNET_RPC_URL } from './constants.ts'

/**
 * Everything the chain package needs from its host. In the Worker these come from bindings and secrets (A1 provides
 * a ConfigProvider over them); in tests and scripts from `packages/stellar/.env`. Secrets stay `Redacted` until the
 * moment a key signs, inside this package.
 */
export interface ChainSettings {
  readonly rpcUrl: string
  readonly networkPassphrase: string
  /** One to three relayer `S…` secrets: transaction source and fee payer for everything. */
  readonly relayerSecrets: ReadonlyArray<Redacted.Redacted>
  /** Holds testnet USDC for `fundNewWallet`. */
  readonly treasurySecret: Option.Option<Redacted.Redacted>
  /** Any string with ≥ 128 bits of entropy; AES-GCM key for connection keys is derived from it with HKDF. */
  readonly vaultKey: Redacted.Redacted
  /** x402 facilitators, probed by `health()` (the seller picks the one that settles). */
  readonly facilitatorUrl: string
  readonly fallbackFacilitatorUrl: string
  readonly ozApiKey: Option.Option<Redacted.Redacted>
  /** The seeded demo recipient (Carol) for the claim link's `?demo=1` path; testnet only. */
  readonly demoRecipientSecret: Option.Option<Redacted.Redacted>
  /** Refuse to submit when the enforce simulation's fee is above this (stroops). Default 30 XLM. */
  readonly maxFeeStroops: bigint
  /** TTL set on each new wallet's instance right after deploy (ledgers; 0 = leave the network minimum). */
  readonly walletTtlLedgers: number
  /** How long an owner's passkey auth stays valid between prepare and finalize (ledgers). Default 400 ≈ 33 min. */
  readonly ownerAuthLedgers: number
  /** The fetch used for x402 and MCP requests (`globalThis.fetch` bound in the Worker). */
  readonly fetch: typeof globalThis.fetch
}

export const DEFAULT_MAX_FEE_STROOPS = 300_000_000n
export const DEFAULT_OWNER_AUTH_LEDGERS = 400
/** 30 days of 5 s ledgers. */
export const DEFAULT_WALLET_TTL_LEDGERS = 518_400

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

/**
 * Bindings read: `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `RELAYER_SECRETS` (comma-separated; or
 * `RELAYER_SECRET`), `TREASURY_SECRET`, `VAULT_KEY`, `X402_FACILITATOR_URL`, `X402_FALLBACK_FACILITATOR_URL`,
 * `OZ_FACILITATOR_KEY` (or `OZ_CHANNELS_API_KEY`), `DEMO_RECIPIENT_SECRET`, `MAX_FEE_STROOPS`, `OWNER_AUTH_LEDGERS`, `WALLET_TTL_LEDGERS`.
 */
export const chainSettingsConfig = Config.all({
  rpcUrl: Config.String('STELLAR_RPC_URL').pipe(Config.withDefault(TESTNET_RPC_URL)),
  networkPassphrase: Config.String('STELLAR_NETWORK_PASSPHRASE').pipe(Config.withDefault(TESTNET_PASSPHRASE)),
  relayerSecrets: secretList('RELAYER_SECRETS').pipe(Config.orElse(() => secretList('RELAYER_SECRET'))),
  treasurySecret: Config.option(Config.Redacted('TREASURY_SECRET')),
  vaultKey: Config.Redacted('VAULT_KEY'),
  facilitatorUrl: Config.String('X402_FACILITATOR_URL').pipe(Config.withDefault(HOSTED_FACILITATOR_URL)),
  fallbackFacilitatorUrl: Config.String('X402_FALLBACK_FACILITATOR_URL').pipe(Config.withDefault(OZ_FACILITATOR_URL)),
  ozApiKey: Config.option(
    Config.Redacted('OZ_FACILITATOR_KEY').pipe(Config.orElse(() => Config.Redacted('OZ_CHANNELS_API_KEY'))),
  ),
  demoRecipientSecret: Config.option(Config.Redacted('DEMO_RECIPIENT_SECRET')),
  maxFeeStroops: Config.String('MAX_FEE_STROOPS').pipe(
    Config.map(s => BigInt(s)),
    Config.withDefault(DEFAULT_MAX_FEE_STROOPS),
  ),
  ownerAuthLedgers: Config.Int('OWNER_AUTH_LEDGERS').pipe(Config.withDefault(DEFAULT_OWNER_AUTH_LEDGERS)),
  walletTtlLedgers: Config.Int('WALLET_TTL_LEDGERS').pipe(Config.withDefault(DEFAULT_WALLET_TTL_LEDGERS)),
})

export class ChainConfig extends Context.Service<ChainConfig, ChainSettings>()('hm/stellar/ChainConfig') {
  /** Settings from the ambient ConfigProvider (Worker bindings, or env in scripts). */
  static readonly fromConfig = (fetchImpl: typeof globalThis.fetch) =>
    Layer.effect(
      ChainConfig,
      Effect.gen(function* () {
        const settings = yield* chainSettingsConfig
        if (settings.relayerSecrets.length === 0) return yield* Effect.die('RELAYER_SECRETS is empty')
        return ChainConfig.of({ ...settings, fetch: fetchImpl })
      }),
    )

  static readonly layer = (settings: ChainSettings) => Layer.succeed(ChainConfig, ChainConfig.of(settings))
}
