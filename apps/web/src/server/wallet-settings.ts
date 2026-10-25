import { Config, ConfigProvider, Context, Effect, Layer, Option } from 'effect'

/**
 * The wallet service's switches, from the Worker's string bindings (apps/web/alchemy.run.ts). Secrets (relayer,
 * treasury, vault, OZ key, demo recipient) are not here: only the chain package reads them, from the same bindings.
 */
export class WalletSettings extends Context.Service<
  WalletSettings,
  {
    readonly stage: string
    /** `fixture`: the deterministic in-memory chain; `testnet`: @hm/stellar on Stellar testnet. */
    readonly chain: 'fixture' | 'testnet'
    /** WebAuthn relying party id; defaults to the request's host name. */
    readonly rpId: Option.Option<string>
    /** The page origin passkeys are bound to; defaults to the request's origin. */
    readonly origin: Option.Option<string>
    /** USDC a new wallet receives from the treasury on testnet (the judge path), in stroops. */
    readonly welcomeUsdc: bigint
  }
>()('hm/WalletSettings') {
  static readonly fromBindings = (bindings: object) =>
    Layer.effect(WalletSettings, load).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(stringBindings(bindings)))),
    )
}

const load = Effect.gen(function* () {
  return {
    stage: yield* Config.String('STAGE').pipe(Config.withDefault('local')),
    chain: yield* Config.Literals(['fixture', 'testnet'], 'CHAIN').pipe(Config.withDefault('fixture' as const)),
    rpId: yield* Config.option(Config.String('RP_ID')),
    origin: yield* Config.option(Config.String('ORIGIN')),
    welcomeUsdc: yield* Config.String('WELCOME_USDC_STROOPS').pipe(
      Config.map(text => BigInt(text)),
      Config.withDefault(100_000_000n),
    ),
  }
})

/** The plain-text bindings; resource bindings (D1, Durable Objects, ASSETS) are objects and are not settings. */
export const stringBindings = (bindings: object): Record<string, string> =>
  Object.fromEntries(
    Object.entries(bindings).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

/** Where passkeys and links of this request live. */
export interface Site {
  readonly origin: string
  readonly rpId: string
}

export const siteOf = (request: Request) =>
  WalletSettings.useSync(settings => {
    const url = new URL(request.url)
    return {
      origin: Option.getOrElse(settings.origin, () => url.origin),
      rpId: Option.getOrElse(settings.rpId, () => url.hostname),
    }
  })
