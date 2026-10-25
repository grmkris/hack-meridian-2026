import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from 'effect'

/** A contact every new wallet starts with on the demo stages (scripts/demo/seeds.json). */
export const DemoContact = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
  trustline_required: Schema.Boolean,
})
export type DemoContact = typeof DemoContact.Type
export const DemoContacts = Schema.Array(DemoContact)

/** DEMO_CONTACTS as a binding string → the list; anything unreadable is no contacts. */
export const parseDemoContacts = (text: string | undefined): ReadonlyArray<DemoContact> => {
  if (text === undefined || text === '') return []
  try {
    return Schema.decodeUnknownOption(DemoContacts)(JSON.parse(text)).pipe(Option.getOrElse(() => []))
  } catch {
    return []
  }
}

/**
 * The wallet service's switches, from the Worker's string bindings (apps/web/alchemy.run.ts). Secrets (relayer,
 * treasury, vault, OZ key, demo recipient) are not here: only the chain package reads them, from the same bindings.
 */
export class WalletSettings extends Context.Service<
  WalletSettings,
  {
    readonly stage: string
    /** `fixture`: the deterministic in-memory chain; `testnet`/`stellar`: @hm/stellar on STELLAR_NETWORK. */
    readonly chain: 'fixture' | 'testnet' | 'stellar'
    /** WebAuthn relying party id; defaults to the request's host name. */
    readonly rpId: Option.Option<string>
    /** The page origin passkeys are bound to; defaults to the request's origin. */
    readonly origin: Option.Option<string>
    /** USDC a new wallet receives from the treasury on testnet (the judge path), in stroops. */
    readonly welcomeUsdc: bigint
    /** Contacts every new wallet starts with (demo stages only). */
    readonly demoContacts: ReadonlyArray<DemoContact>
    /** DEMO_CLAIM_SIGNER: the demo recipient's key signs claims off testnet too (mainnet, Carol is ours). */
    readonly demoClaimSigner?: boolean
    /**
     * SEED_DEMO_CONTACTS: new wallets start with the demo contacts. Unset: on testnet only, so a stranger's new mainnet
     * wallet starts empty and "pay Bob" never pays Nod's seed account; true on mainnet for a recording wallet.
     */
    readonly seedDemoContacts?: boolean
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
    chain: yield* Config.Literals(['fixture', 'testnet', 'stellar'], 'CHAIN').pipe(
      Config.withDefault('fixture' as const),
    ),
    rpId: yield* Config.option(Config.String('RP_ID')),
    origin: yield* Config.option(Config.String('ORIGIN')),
    welcomeUsdc: yield* Config.String('WELCOME_USDC_STROOPS').pipe(
      Config.map(text => BigInt(text)),
      Config.withDefault(100_000_000n),
    ),
    demoContacts: parseDemoContacts(yield* Config.String('DEMO_CONTACTS').pipe(Config.withDefault(''))),
    demoClaimSigner: yield* Config.Boolean('DEMO_CLAIM_SIGNER').pipe(Config.withDefault(false)),
    ...Option.match(yield* Config.option(Config.Boolean('SEED_DEMO_CONTACTS')), {
      onNone: () => ({}),
      onSome: seedDemoContacts => ({ seedDemoContacts }),
    }),
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
