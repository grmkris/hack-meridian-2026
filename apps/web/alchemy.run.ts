import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect, Redacted, Schema } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The one stack: the Foldkit app and its Worker (src/worker.ts, which answers /api) as one Cloudflare Worker with
 * static assets. Stages: `local` under `alchemy dev` (bun run dev), `testnet` and `mainnet` on workers.dev and their
 * trynod.si hostnames (DOMAINS). Every stage keeps its Alchemy state in this checkout (.alchemy/, gitignored), so nothing
 * here touches the account's shared state store, whose version moves with myapps and goblin. Run it only through
 * scripts/stage.ts.
 */
const STAGES = ['local', 'testnet', 'mainnet'] as const
/** Stellar mainnet: real money. Defined here, deployed only on Kristjan's explicit call. */
const isMainnet = (stage: string) => stage === 'mainnet'
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

/**
 * Each stage's public hostnames in the trynod.si zone, canonical first (docs/DOMAIN.md). The canonical one is the
 * default ORIGIN; RP_ID defaults to the zone, so one passkey works on both stages. A stage whose ORIGIN is its canonical
 * hostname gets the hostnames as Cloudflare custom domains (Alchemy creates the DNS records and certificates); an
 * ORIGIN pinned elsewhere in `.env.<stage>` (the workers.dev URL) keeps the domain unattached, so a stage has one
 * identity. workers.dev stays enabled; the Worker sends every other host to ORIGIN (src/server/canonical.ts).
 */
const ZONE = 'trynod.si'
const DOMAINS: Record<(typeof STAGES)[number], ReadonlyArray<string>> = {
  local: [],
  testnet: [`testnet.${ZONE}`],
  mainnet: [ZONE, `www.${ZONE}`],
}
const hostsOf = (stage: string): ReadonlyArray<string> => {
  const known = STAGES.find(name => name === stage)
  return known === undefined ? [] : DOMAINS[known]
}
/** The Worker `domain` prop, by name only (a zone pin makes `alchemy drift` report the Worker on every run). */
const customDomain = (stage: string, origin: string | undefined) => {
  const [name, ...aliases] = hostsOf(stage)
  if (name === undefined || origin === undefined || new URL(origin).origin !== `https://${name}`) return undefined
  return aliases.length === 0 ? { name } : { name, aliases }
}

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
  'RELAYER_SECRETS',
  'TREASURY_SECRET',
  'OZ_FACILITATOR_KEY',
  'DEMO_RECIPIENT_SECRET',
  'INVITE_CODES',
] as const
/**
 * Switches with their defaults per stage ('' = unset: the chain package's network preset decides). CHAIN picks the
 * fixture or the real chain; the caps and PAYMENTS_ENABLED are checked by the service before any chain call.
 */
const switchesFor = (stage: string): Record<string, string> => ({
  CHAIN: isMainnet(stage) ? 'stellar' : 'fixture',
  X402_FACILITATOR_URL: '',
  RP_ID: hostsOf(stage).length === 0 ? '' : ZONE,
  ORIGIN: hostsOf(stage).map(host => `https://${host}`)[0] ?? '',
  MAX_GRANT_USDC: '20',
  MAX_OWNER_PAYMENT_USDC: isMainnet(stage) ? '50' : '100',
  MAX_X402_PRICE_USDC: '1',
  PAYMENTS_ENABLED: 'true',
  // Wallet creation needs an invite code: 'true' or 'false'; '' = the network decides (invite-only on pubnet).
  INVITE_REQUIRED: '',
  // Hourly signup throttling is disabled on every stage. Limits apply only when explicitly enabled.
  WALLET_CREATE_LIMITS_ENABLED: 'false',
  WALLET_CREATE_PER_VISITOR_HOUR: stage === 'local' ? '100' : '',
  WALLET_CREATE_PER_HOUR: stage === 'local' ? '1000' : '',
  // /sample: a server-side sample agent on Nod's demo wallet (testnet only; the page refuses on any other network).
  SAMPLE_ENABLED: isMainnet(stage) ? 'false' : 'true',
  WALLET_TTL_LEDGERS: '',
  // The CAP-73 router: the testnet preset has S3's; pubnet has none until scripts/mainnet/router-deploy.ts (M3).
  ONBOARD_ROUTER_ID: '',
  // The deposit router (contracts/deposit): the testnet preset has v2; pubnet has none until
  // scripts/mainnet/deposit-router-deploy.ts, then .env.mainnet names it. 'off' disables deposit addresses.
  DEPOSIT_ROUTER_ID: '',
  // The claim page's server-side demo signer off testnet ('' = testnet only); .env.mainnet sets it for our own Carol.
  DEMO_CLAIM_SIGNER: '',
  // Structured logs (src/server/observe): the lowest level written, Debug | Info | Warn | Error; '' = Info.
  LOG_LEVEL: stage === 'local' ? 'Warn' : '',
  // New wallets start with the demo contacts: '' = testnet only; 'true' in .env.mainnet for a recording wallet.
  SEED_DEMO_CONTACTS: '',
  // Mainnet's contacts come from .env.mainnet (scripts/mainnet/seed.ts prints them); the other stages use seeds.json.
  ...(isMainnet(stage) ? { DEMO_CONTACTS: '[]' } : {}),
  // Fee ceilings in stroops; '' = the chain package's network preset (testnet 40 / 35 / 4 XLM, mainnet 1 / 0.5 / 0.1
  // XLM), and a transfer's ceiling still follows the live rent factor up to its hard cap (src/server/network.ts). The
  // 300 / 100 / 40 XLM testnet defaults of the 25 Oct rent spike are gone now the rent is at its floor (K5); an
  // `.env.<stage>` line still overrides (.env.mainnet keeps its 1 XLM ceilings).
  MAX_FEE_STROOPS: '',
  FIRST_PULL_MAX_FEE_STROOPS: '',
  PULL_MAX_FEE_STROOPS: '',
})

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
    for (const [name, fallback] of Object.entries(switchesFor(stage))) {
      const value = file[name] ?? (yield* Config.String(name).pipe(Config.withDefault(fallback)))
      if (value !== '') switches[name] = value
    }
    const real = switches['CHAIN'] === 'testnet' || switches['CHAIN'] === 'stellar'
    if (real && (!(secrets['RELAYER_SECRET'] ?? secrets['RELAYER_SECRETS']) || !secrets['VAULT_KEY']))
      return yield* Effect.die(
        new Error(`CHAIN=${switches['CHAIN']} needs RELAYER_SECRET and VAULT_KEY (apps/web/.env.${stage})`),
      )
    // Passkeys made on ORIGIN must be able to name RP_ID: it is ORIGIN's host or a parent of it (a half-done cutover,
    // one of the two pinned in .env.<stage> and the other from DOMAINS, fails here instead of at the first passkey).
    const origin = switches['ORIGIN']
    const rpId = switches['RP_ID']
    if (origin !== undefined && rpId !== undefined) {
      const host = new URL(origin).hostname
      if (host !== rpId && !host.endsWith(`.${rpId}`))
        return yield* Effect.die(new Error(`RP_ID ${rpId} does not cover ORIGIN ${origin} (apps/web/.env.${stage})`))
    }
    return { bindings: { ...secrets, ...switches }, origin }
  })

/**
 * The demo contacts (Alice C…, Bob G… ready, Carol G… without a trustline) from stream C's public seed record; every
 * new wallet on a testnet-network stage starts with them. Public addresses only.
 */
const SeedContacts = Schema.Struct({
  contacts: Schema.Record(Schema.String, Schema.Struct({ address: Schema.String, expected_readiness: Schema.String })),
})
const demoContacts = (): string => {
  const file = path('../../scripts/demo/seeds.json')
  if (!existsSync(file)) return '[]'
  const seeds = Schema.decodeUnknownSync(SeedContacts)(JSON.parse(readFileSync(file, 'utf8')))
  return JSON.stringify(
    Object.entries(seeds.contacts).map(([name, contact]) => ({
      name,
      address: contact.address,
      trustline_required: contact.expected_readiness.startsWith('trustline_required'),
    })),
  )
}

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
    const wallet = yield* walletEnv(stage)
    const domain = customDomain(stage, wallet.origin)
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
      ...(domain === undefined ? {} : { domain }),
      // global_fetch_strictly_public: workers-oauth-provider fetches CIMD client documents (docs/spikes/s4.md).
      compatibility: { date: '2026-10-09', flags: ['global_fetch_strictly_public'] },
      // Written out in full: a partial object replaces Alchemy's default and silently turns Workers Logs off. Traces
      // stay off: Effect's HTTP span would store OAuth codes and claim links in its attributes (no redacting tracer).
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
      },
      // Every path reaches the Worker first: it answers /api, /mcp, OAuth, the owner pages and /sample itself and hands
      // everything else to the static assets (src/worker.ts). Worker-first everywhere lets the canonical-origin redirect
      // (src/server/canonical.ts) cover the landing and the client routes too, so an alias host never serves the app.
      assets: { runWorkerFirst: ['/*'] },
      dev: { port: 18960, strictPort: true },
      memo: { include: BUILD_INPUTS, lockfile: true },
      env: {
        STAGE: stage,
        RELEASE: release,
        // Mainnet takes every network field from the chain package's pubnet preset; the counter is testnet only.
        ...(isMainnet(stage)
          ? { STELLAR_NETWORK: 'pubnet' }
          : {
              STELLAR_NETWORK: deployment.network,
              STELLAR_RPC_URL: deployment.rpcUrl,
              STELLAR_NETWORK_PASSPHRASE: deployment.networkPassphrase,
              COUNTER_CONTRACT_ID: deployment.contracts.counter.id,
              DEMO_CONTACTS: demoContacts(),
            }),
        WALLET_DB: db,
        WALLET_OBJECT: Cloudflare.DurableObject('WalletObject', { className: 'WalletObject' }),
        OAUTH_STORE: Cloudflare.DurableObject('OAuthStore', { className: 'OAuthStore' }),
        // /sample's lock, rate limits and run logs; a run executes in its alarm (apps/web/src/server/sample).
        SAMPLE_RUNNER: Cloudflare.DurableObject('SampleRunner', { className: 'SampleRunner' }),
        ...wallet.bindings,
      },
    })
    return { url: web.url, walletDatabase: db.databaseId }
  }),
)
