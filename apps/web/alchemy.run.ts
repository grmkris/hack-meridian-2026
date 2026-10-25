import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect, Redacted, Schema } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The one stack: the Foldkit app and its Worker (src/worker.ts, which answers /api) as one Cloudflare Worker with
 * static assets. Stages: `local` under `alchemy dev` (bun run dev) and `testnet` on workers.dev. Every stage keeps its
 * Alchemy state in this checkout (.alchemy/, gitignored), so nothing here touches the account's shared state store,
 * whose version moves with myapps and goblin. Run it only through scripts/stage.ts.
 */
const STAGES = ['local', 'testnet'] as const
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

/** The public record of the contracts on testnet (ids and hashes), written by `bun run contracts:deploy`. */
const Deployment = Schema.Struct({
  network: Schema.String,
  rpcUrl: Schema.String,
  networkPassphrase: Schema.String,
  contracts: Schema.Struct({ counter: Schema.Struct({ id: Schema.String }) }),
})
const deployment = Schema.decodeUnknownSync(Deployment)(
  JSON.parse(readFileSync(path('../../contracts/deployments/testnet.json'), 'utf8')),
)

/**
 * The wallet service's secrets and switches. Each comes from the stage's gitignored env file (`apps/web/.env.local`,
 * `apps/web/.env.testnet`: `NAME=value` lines) or else the shell, and is bound as a Worker secret. The local stage
 * runs on the fixture chain and needs none of them; `CHAIN=testnet` needs the relayer, treasury and vault keys.
 */
const SECRETS = [
  'VAULT_KEY',
  'RELAYER_SECRET',
  'TREASURY_SECRET',
  'OZ_FACILITATOR_KEY',
  'DEMO_RECIPIENT_SECRET',
] as const
const SWITCHES = { CHAIN: 'fixture', X402_FACILITATOR_URL: 'https://www.x402.org/facilitator', RP_ID: '', ORIGIN: '' }

const readEnvFile = (file: string): Record<string, string> =>
  existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8')
          .split('\n')
          .map(line => line.trim())
          .filter(line => line !== '' && !line.startsWith('#') && line.includes('='))
          .map(line => [
            line.slice(0, line.indexOf('=')).replace(/^export\s+/u, ''),
            line.slice(line.indexOf('=') + 1),
          ]),
      )
    : {}

const walletEnv = (stage: string) =>
  Effect.gen(function* () {
    const file = readEnvFile(path(`./.env.${stage}`))
    const secrets: Record<string, Redacted.Redacted> = {}
    for (const name of SECRETS) {
      const value =
        file[name] ?? Redacted.value(yield* Config.Redacted(name).pipe(Config.withDefault(Redacted.make(''))))
      if (value !== '') secrets[name] = Redacted.make(value)
    }
    const switches: Record<string, string> = {}
    for (const [name, fallback] of Object.entries(SWITCHES)) {
      const value = file[name] ?? (yield* Config.String(name).pipe(Config.withDefault(fallback)))
      if (value !== '') switches[name] = value
    }
    if (switches['CHAIN'] === 'testnet' && (!secrets['RELAYER_SECRET'] || !secrets['VAULT_KEY']))
      return yield* Effect.die(new Error('CHAIN=testnet needs RELAYER_SECRET and VAULT_KEY (apps/web/.env.<stage>)'))
    return { ...secrets, ...switches }
  })

/** What a rebuild depends on: the app, the workspace packages it bundles and the contract record. */
const BUILD_INPUTS = [
  'src/**',
  'public/**',
  'index.html',
  'vite.config.ts',
  'package.json',
  '../../packages/api/src/**',
  '../../packages/protocol/src/**',
  '../../packages/stellar/src/**',
  '../../packages/counter-client/dist/**',
  '../../contracts/deployments/**',
]

export default Alchemy.Stack(
  'hack-meridian',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    if (!STAGES.some(known => known === stage))
      return yield* Effect.die(new Error(`Only the ${STAGES.join(' and ')} stages are defined, not ${stage}.`))
    // The commit scripts/stage.ts deploys, which /api/health reports.
    const release = yield* Config.String('HM_RELEASE').pipe(Config.withDefault('local'))
    // The eight entities of docs/SPEC.md; the wallet's Durable Object is their only writer for money state.
    const db = yield* Cloudflare.D1.Database('WalletDb', {
      name: `hack-meridian-${stage}-wallet`,
      migrations: path('./src/server/migrations'),
      readReplication: { mode: 'disabled' },
    })
    const web = yield* Cloudflare.Website.Foldkit('Web', {
      name: `hack-meridian-${stage}`,
      rootDir: path('./'),
      main: 'src/worker.ts',
      workersDev: true,
      // global_fetch_strictly_public: workers-oauth-provider fetches CIMD client documents (docs/spikes/s4.md).
      compatibility: { date: '2026-10-09', flags: ['global_fetch_strictly_public'] },
      observability: { enabled: true },
      // These reach the Worker; every other path is a built asset or, for a client route, index.html.
      assets: {
        runWorkerFirst: ['/api/*', '/mcp', '/.well-known/*', '/authorize', '/oauth/*', '/approve/*', '/claim/*'],
      },
      dev: { port: 18960, strictPort: true },
      memo: { include: BUILD_INPUTS, lockfile: true },
      env: {
        STAGE: stage,
        RELEASE: release,
        STELLAR_NETWORK: deployment.network,
        STELLAR_RPC_URL: deployment.rpcUrl,
        STELLAR_NETWORK_PASSPHRASE: deployment.networkPassphrase,
        COUNTER_CONTRACT_ID: deployment.contracts.counter.id,
        WALLET_DB: db,
        WALLET_OBJECT: Cloudflare.DurableObject('WalletObject', { className: 'WalletObject' }),
        OAUTH_STORE: Cloudflare.DurableObject('OAuthStore', { className: 'OAuthStore' }),
        ...(yield* walletEnv(stage)),
      },
    })
    return { url: web.url, walletDatabase: db.databaseId }
  }),
)
