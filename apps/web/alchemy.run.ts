import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect, Schema } from 'effect'
import { readFileSync } from 'node:fs'
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

/** What a rebuild depends on: the app, the workspace packages it bundles and the contract record. */
const BUILD_INPUTS = [
  'src/**',
  'public/**',
  'index.html',
  'vite.config.ts',
  'package.json',
  '../../packages/api/src/**',
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
    const web = yield* Cloudflare.Website.Foldkit('Web', {
      name: `hack-meridian-${stage}`,
      rootDir: path('./'),
      main: 'src/worker.ts',
      workersDev: true,
      compatibility: { date: '2026-10-09' },
      observability: { enabled: true },
      // /api reaches the Worker; every other path is a built asset or, for a client route, index.html.
      assets: { runWorkerFirst: ['/api/*'] },
      dev: { port: 18960, strictPort: true },
      memo: { include: BUILD_INPUTS, lockfile: true },
      env: {
        STAGE: stage,
        RELEASE: release,
        STELLAR_NETWORK: deployment.network,
        STELLAR_RPC_URL: deployment.rpcUrl,
        STELLAR_NETWORK_PASSPHRASE: deployment.networkPassphrase,
        COUNTER_CONTRACT_ID: deployment.contracts.counter.id,
      },
    })
    return { url: web.url }
  }),
)
