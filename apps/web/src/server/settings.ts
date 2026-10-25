import { Config, ConfigProvider, Context, Effect, Layer, Option } from 'effect'

/**
 * The stage's settings, read once per isolate from the Worker's string bindings (set in apps/web/alchemy.run.ts). Code
 * reads them through this service, never from `env` or `process.env`.
 */
export class Settings extends Context.Service<
  Settings,
  {
    readonly stage: string
    readonly release: string
    readonly network: string
    readonly rpcUrl: string
    readonly networkPassphrase: string
    readonly counterContractId: Option.Option<string>
  }
>()('hm/Settings') {
  static readonly fromBindings = (bindings: object) =>
    Layer.effect(Settings, load).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(strings(bindings)))),
    )
}

const load = Effect.gen(function* () {
  return {
    stage: yield* Config.String('STAGE'),
    release: yield* Config.String('RELEASE').pipe(Config.withDefault('local')),
    network: yield* Config.String('STELLAR_NETWORK'),
    rpcUrl: yield* Config.String('STELLAR_RPC_URL'),
    networkPassphrase: yield* Config.String('STELLAR_NETWORK_PASSPHRASE'),
    counterContractId: yield* Config.option(Config.String('COUNTER_CONTRACT_ID')),
  }
})

/** The plain-text bindings; resource bindings such as ASSETS are objects and are not settings. */
const strings = (bindings: object): Record<string, string> =>
  Object.fromEntries(
    Object.entries(bindings).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
