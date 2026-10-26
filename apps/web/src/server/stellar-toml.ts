import { Config, ConfigProvider, Effect, Option, Redacted } from 'effect'

import { chainSettingsConfig, networkConfig } from '@hm/stellar'
import { Keypair } from '@stellar/stellar-sdk'

import { stringBindings } from './wallet-settings.ts'

/** SEP-1: wallets and explorers read the stage's home domain from here (docs/tokens/publishing-asset-info). */
export const STELLAR_TOML_PATH = '/.well-known/stellar.toml'

const ORG_DESCRIPTION =
  'Give your AI an allowance: a Stellar wallet your AI app spends from, with a passkey for anything bigger.'

/**
 * The file's inputs, read with the chain package's own config so they are what the running stage signs with: the
 * network passphrase and the public keys of the relayers and the treasury (none on the fixture chain). Secrets are
 * turned into public keys here and go no further.
 */
const inputs = Effect.gen(function* () {
  const chain = yield* Config.String('CHAIN').pipe(Config.withDefault('fixture'))
  if (chain !== 'testnet' && chain !== 'stellar') return { passphrase: (yield* networkConfig).passphrase, accounts: [] }
  const settings = yield* chainSettingsConfig
  const secrets = [...settings.relayerSecrets, ...Option.toArray(settings.treasurySecret)]
  const accounts = yield* Effect.try({
    try: () => secrets.map(secret => Keypair.fromSecret(Redacted.value(secret)).publicKey()),
    // Never the thrown error: it may quote the input.
    catch: () => 'a configured relayer or treasury secret is not a Stellar secret key',
  })
  return { passphrase: settings.network.passphrase, accounts: [...new Set(accounts)] }
})

/** TOML basic strings take JSON's escapes. */
const str = (text: string) => JSON.stringify(text)

const render = (passphrase: string, accounts: ReadonlyArray<string>, origin: string) =>
  [
    'VERSION="2.0.0"',
    `NETWORK_PASSPHRASE=${str(passphrase)}`,
    `ACCOUNTS=[${accounts.map(str).join(', ')}]`,
    '',
    '[DOCUMENTATION]',
    'ORG_NAME="Nod"',
    `ORG_URL=${str(origin)}`,
    `ORG_DESCRIPTION=${str(ORG_DESCRIPTION)}`,
    'ORG_GITHUB="grmkris/hack-meridian-2026"',
    '',
  ].join('\n')

/** GET /.well-known/stellar.toml: this stage's SEP-1 file, readable from any origin, cached for five minutes. */
export const stellarToml = async (request: Request, env: object): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  const bindings = stringBindings(env)
  const origin =
    bindings['ORIGIN'] === undefined || bindings['ORIGIN'] === '' ? new URL(request.url).origin : bindings['ORIGIN']
  const read = await Effect.runPromise(
    inputs.pipe(
      Effect.asSome,
      Effect.catch(() => Effect.as(Effect.logWarning('stellar_toml.settings_unreadable'), Option.none())),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(bindings))),
    ),
  )
  if (Option.isNone(read)) return new Response('stellar.toml is unavailable on this stage', { status: 503 })
  const body = render(read.value.passphrase, read.value.accounts, origin)
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
