import { ConfigProvider, Effect, Exit, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  chainSettingsConfig,
  missingFields,
  networkConfig,
  PUBNET,
  TESTNET,
  USDC_SAC,
  usdcToStroops,
} from '../src/index.ts'

const withEnv = <A, E>(env: Record<string, string>, effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))))

const secrets = { RELAYER_SECRET: 'SA' + 'A'.repeat(54), VAULT_KEY: 'v'.repeat(32) }

describe('network presets', () => {
  it('testnet is complete; pubnet has the mainnet ids and only lacks the router', () => {
    expect(missingFields(TESTNET)).toEqual([])
    // docs/research/mainnet.md: Circle USDC's mainnet SAC, derived here from the issuer.
    expect(PUBNET.contracts.usdcSac).toBe('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75')
    expect(PUBNET.contracts.nativeSac).toMatch(/^C[A-Z2-7]{55}$/u)
    expect(PUBNET.contracts.accountWasmHash).toBe(TESTNET.contracts.accountWasmHash)
    expect(missingFields(PUBNET)).toEqual(['onboardRouter (ONBOARD_ROUTER_ID)'])
    expect(PUBNET.fees.maxFeeStroops).toBe(10_000_000n)
  })

  it('defaults to testnet and applies per-field overrides', async () => {
    const plain = await withEnv({}, networkConfig)
    expect(Exit.isSuccess(plain) && plain.value.name).toBe('testnet')
    const exit = await withEnv(
      {
        STELLAR_RPC_URL: 'https://rpc.example',
        STELLAR_EXPLORER_URL: 'https://x.example/',
        STELLAR_FRIENDBOT_URL: 'off',
      },
      networkConfig,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    const n = Exit.isSuccess(exit) ? exit.value : TESTNET
    expect(n.rpcUrl).toBe('https://rpc.example')
    expect(n.explorerBase).toBe('https://x.example')
    expect(n.friendbotUrl).toBeNull()
    expect(n.contracts.usdcSac).toBe(USDC_SAC)
  })

  it('refuses pubnet until the router is configured, then accepts it', async () => {
    const refused = await withEnv({ STELLAR_NETWORK: 'pubnet' }, networkConfig)
    expect(String(Exit.isFailure(refused) ? refused.cause : '')).toContain('ONBOARD_ROUTER_ID')
    const ok = await withEnv(
      { STELLAR_NETWORK: 'mainnet', ONBOARD_ROUTER_ID: TESTNET.contracts.onboardRouter },
      networkConfig,
    )
    expect(Exit.isSuccess(ok) && ok.value.name).toBe('pubnet')
    expect(Exit.isSuccess(ok) && ok.value.x402Network).toBe('stellar:pubnet')
    expect(Exit.isSuccess(ok) && ok.value.explorerBase).toBe('https://stellar.expert/explorer/public')
    expect(Exit.isSuccess(ok) && ok.value.rpcFallbackUrl).toBe('https://soroban-rpc.mainnet.stellar.gateway.fm')
    expect(Exit.isFailure(await withEnv({ STELLAR_NETWORK: 'futurenet' }, networkConfig))).toBe(true)
  })
})

describe('safety caps and the kill switch', () => {
  it('defaults: 20 USDC grant, 100 USDC owner payment, 1 USDC x402 price, payments enabled', async () => {
    const exit = await withEnv(secrets, chainSettingsConfig)
    expect(Exit.isSuccess(exit)).toBe(true)
    const s = Exit.isSuccess(exit) ? exit.value : undefined
    expect(s?.caps).toEqual({
      maxGrantStroops: 200_000_000n,
      maxOwnerPaymentStroops: 1_000_000_000n,
      maxX402PriceStroops: 10_000_000n,
      paymentsEnabled: true,
    })
    expect(s?.relayerSecrets.map(Redacted.value)).toEqual([secrets.RELAYER_SECRET])
    expect(s?.maxFeeStroops).toBe(TESTNET.fees.maxFeeStroops)
  })

  it('reads overrides and a comma-separated relayer list', async () => {
    const exit = await withEnv(
      {
        ...secrets,
        RELAYER_SECRET: `${secrets.RELAYER_SECRET},SB${'B'.repeat(54)}`,
        MAX_GRANT_USDC: '5',
        MAX_X402_PRICE_USDC: '0.25',
        PAYMENTS_ENABLED: 'false',
      },
      chainSettingsConfig,
    )
    const s = Exit.isSuccess(exit) ? exit.value : undefined
    expect(s?.relayerSecrets).toHaveLength(2)
    expect(s?.caps.maxGrantStroops).toBe(50_000_000n)
    expect(s?.caps.maxX402PriceStroops).toBe(2_500_000n)
    expect(s?.caps.paymentsEnabled).toBe(false)
  })

  it('parses USDC amounts exactly', () => {
    expect(usdcToStroops('0.1')).toBe(1_000_000n)
    expect(usdcToStroops('100')).toBe(1_000_000_000n)
    expect(() => usdcToStroops('1.12345678')).toThrow(RangeError)
  })
})
