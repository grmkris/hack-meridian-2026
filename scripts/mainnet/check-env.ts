import { Cause, ConfigProvider, Effect, Exit, Layer } from 'effect'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { Settings } from '../../apps/web/src/server/settings.ts'
import { parseDemoContacts, WalletSettings } from '../../apps/web/src/server/wallet-settings.ts'
import { chainSettingsConfig, StellarOps, stellarLayer, usdcToStroops } from '../../packages/stellar/src/index.ts'
import { FILES, ROLE_LIST, ROLES, ROOT, assertPrivate, readEnvFile, routerId, xlm } from './lib.ts'

/**
 * Does the mainnet stage boot with apps/web/.env.mainnet? No network access, nothing signed, no value printed.
 *
 *   bun scripts/mainnet/check-env.ts
 *
 * 1. Which names apps/web/alchemy.run.ts would bind for the `mainnet` stage: it reads only its SECRETS and
 *    switchesFor names from the env file (parsed from its source here), plus the stage's own env literals.
 * 2. Formats: secrets are valid and match scripts/demo/.env.pubnet, caps and ceilings parse, RP_ID covers ORIGIN, the
 *    invite code, the router id, DEMO_CONTACTS.
 * 3. The bindings through the same Config layers the Worker uses (@hm/stellar's chainSettingsConfig and stellarLayer,
 *    the Worker's Settings and WalletSettings), as alchemy binds them; while ONBOARD_ROUTER_ID is empty (before M3),
 *    again with the router id precomputed from relayer A.
 * Exit 1 on a format failure or when the stage would not boot (with the router id once M3 has run).
 */
const failures: Array<string> = []
const notes: Array<string> = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

assertPrivate(FILES.web)
assertPrivate(FILES.demo)
const file = readEnvFile(FILES.web)
const demo = readEnvFile(FILES.demo)

// ------------------------------------------------------------------------------------------- 1. what alchemy binds
const alchemy = readFileSync(join(ROOT, 'apps/web/alchemy.run.ts'), 'utf8')
const namesIn = (block: string | undefined, pattern: RegExp) =>
  block === undefined ? [] : Array.from(block.matchAll(pattern), m => m[1] ?? '').filter(n => n !== '')
const secretNames = namesIn(/const SECRETS = \[([\s\S]*?)\] as const/u.exec(alchemy)?.[1], /'([A-Z0-9_]+)'/gu)
const switchBlock = /const switchesFor = [\s\S]*?=> \(\{([\s\S]*?)\n\}\)/u.exec(alchemy)?.[1]
const switchNames = namesIn(
  switchBlock
    ?.split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n'),
  /\b([A-Z][A-Z0-9_]{2,}):/gu,
)
const literals = Object.fromEntries(
  Array.from(
    (/RELEASE: release,[\s\S]*?isMainnet\(stage\)\s*\?\s*\{([^}]*)\}/u.exec(alchemy)?.[1] ?? '').matchAll(
      /([A-Z0-9_]+): '([^']*)'/gu,
    ),
    m => [m[1] ?? '', m[2] ?? ''],
  ),
)
if (literals['STELLAR_NETWORK'] !== 'pubnet') throw new Error('could not read the mainnet stage literals')
if (secretNames.length === 0 || switchNames.length === 0) throw new Error('could not read SECRETS/switchesFor')
/** What the Worker would see: the stage literals, then the SECRETS and switches names the file sets (non-empty). */
const bindingsOf = (values: Record<string, string>) => {
  const out: Record<string, string> = { STAGE: 'mainnet', RELEASE: 'check-env', ...literals }
  for (const name of [...secretNames, ...switchNames]) {
    const value = values[name]
    if (value !== undefined && value !== '') out[name] = value
  }
  return out
}
const bound = bindingsOf(file)
const ignored = Object.keys(file)
  .filter(name => !secretNames.includes(name) && !switchNames.includes(name))
  .map(name =>
    name in literals
      ? `${name} (the stage literal '${literals[name] ?? ''}' wins)`
      : file[name] === ''
        ? `${name} (empty now)`
        : name,
  )
console.log('\n1. apps/web/alchemy.run.ts, mainnet stage')
console.log(`  binds from the file: ${[...secretNames, ...switchNames].filter(n => n in bound).join(', ')}`)
console.log(
  `  stage literals: ${Object.entries(literals)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}`,
)
console.log(`  in the file but NOT bound by it: ${ignored.length === 0 ? 'none' : ignored.join(', ')}`)

// ------------------------------------------------------------------------------------------- 2. formats
console.log('\n2. formats (values not printed)')
const secretOk = (s: string | undefined) => s !== undefined && Stellar.StrKey.isValidEd25519SecretSeed(s)
const relayers = (file['RELAYER_SECRET'] ?? '').split(',')
check(relayers.length === 2 && relayers.every(secretOk), 'RELAYER_SECRET: two valid secret seeds')
check(
  relayers[0] === demo[ROLES.relayerA] && relayers[1] === demo[ROLES.relayerB],
  'RELAYER_SECRET = relayer A, relayer B of scripts/demo/.env.pubnet',
)
check(
  secretOk(file['TREASURY_SECRET']) && file['TREASURY_SECRET'] === demo[ROLES.treasury],
  'TREASURY_SECRET = treasury',
)
check(
  secretOk(file['DEMO_RECIPIENT_SECRET']) && file['DEMO_RECIPIENT_SECRET'] === demo[ROLES.carol],
  'DEMO_RECIPIENT_SECRET = Carol',
)
const pubs = ROLE_LIST.map(role => demo[ROLES[role]] ?? '').filter(secretOk)
check(pubs.length === 6 && new Set(pubs).size === 6, 'six distinct demo accounts')
check(/^[0-9a-f]{64}$/u.test(file['VAULT_KEY'] ?? ''), 'VAULT_KEY: 32 random bytes, hex')
const invites = (file['INVITE_CODES'] ?? '').split(',').filter(code => code !== '')
check(invites.length === 1 && invites.every(code => /^[a-z0-9]{16}$/u.test(code)), 'INVITE_CODES: one 16-char code')
check(file['CHAIN'] === 'stellar' && file['STELLAR_NETWORK'] === 'pubnet', 'CHAIN=stellar, STELLAR_NETWORK=pubnet')
const origin = URL.parse(file['ORIGIN'] ?? '')
const rpId = file['RP_ID'] ?? ''
check(
  origin?.protocol === 'https:' && (origin.hostname === rpId || origin.hostname.endsWith(`.${rpId}`)),
  `RP_ID ${rpId} covers ORIGIN ${file['ORIGIN'] ?? ''}`,
)
const caps = { MAX_GRANT_USDC: '20', MAX_OWNER_PAYMENT_USDC: '50', MAX_X402_PRICE_USDC: '1' }
for (const [name, want] of Object.entries(caps))
  check(usdcToStroops(file[name] ?? 'x') === usdcToStroops(want), `${name}=${want}`)
for (const name of ['MAX_FEE_STROOPS', 'FIRST_PULL_MAX_FEE_STROOPS', 'PULL_MAX_FEE_STROOPS'])
  check(file[name] === '10000000', `${name}: 1 XLM`)
check(
  file['PAYMENTS_ENABLED'] === 'true' && file['SAMPLE_ENABLED'] === 'false',
  'PAYMENTS_ENABLED=true, SAMPLE_ENABLED=false',
)
check(file['DEMO_CLAIM_SIGNER'] === 'true', 'DEMO_CLAIM_SIGNER=true (Carol is ours)')
const router = file['ONBOARD_ROUTER_ID'] ?? ''
check(router === '' || router === routerId(), `ONBOARD_ROUTER_ID ${router === '' ? 'empty (M3)' : router}`)
const contacts = parseDemoContacts(file['DEMO_CONTACTS'])
check(file['DEMO_CONTACTS'] === '[]' || contacts.length === 3, `DEMO_CONTACTS: ${contacts.length} contacts`)
if ((file['OZ_FACILITATOR_KEY'] ?? '') === '') notes.push('OZ_FACILITATOR_KEY empty (M4)')

// ------------------------------------------------------------------------------------------- 3. the Config layers
const provider = (record: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromEnvRecord(record))
const reason = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split('\n')[0] ?? 'failed'

async function boot(label: string, record: Record<string, string>) {
  console.log(`\n3. ${label}`)
  const settings = await Effect.runPromiseExit(chainSettingsConfig.pipe(Effect.provide(provider(record))))
  if (Exit.isFailure(settings)) {
    console.log(`  chainSettingsConfig: FAILS: ${reason(settings.cause)}`)
    return false
  }
  const s = settings.value
  const ops = await Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* StellarOps
    }).pipe(Effect.provide(stellarLayer(fetch.bind(globalThis)).pipe(Layer.provide(provider(record))))),
  )
  const web = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const wallet = yield* WalletSettings
      const stage = yield* Settings
      return { wallet, stage }
    }).pipe(Effect.provide(Layer.merge(WalletSettings.fromBindings(record), Settings.fromBindings(record)))),
  )
  if (Exit.isFailure(ops) || Exit.isFailure(web)) {
    console.log(
      `  layers: FAIL: ${Exit.isFailure(ops) ? reason(ops.cause) : Exit.isFailure(web) ? reason(web.cause) : ''}`,
    )
    return false
  }
  const n = ops.value.network
  console.log(`  @hm/stellar: network ${n.name} (${n.passphrase.slice(0, 22)}…), x402 ${n.x402Network}`)
  console.log(
    `  rpc ${n.rpcUrl}, fallback ${n.rpcFallbackUrl ?? '-'}, horizon ${n.horizonUrl}, friendbot ${n.friendbotUrl ?? 'off'}`,
  )
  console.log(`  facilitator ${n.facilitatorUrl || '-'}, fallback ${n.fallbackFacilitatorUrl || '-'}`)
  console.log(
    `  USDC ${n.contracts.usdcSac}, router ${n.contracts.onboardRouter}, policy ${n.contracts.spendingLimitPolicy}`,
  )
  console.log(
    `  relayers ${s.relayerSecrets.length}, treasury ${s.treasurySecret._tag === 'Some' ? 'set' : 'unset'}, OZ key ${s.ozApiKey._tag === 'Some' ? 'set' : 'unset'}, demo recipient ${s.demoRecipientSecret._tag === 'Some' ? 'set' : 'unset'}`,
  )
  const c = ops.value.caps
  console.log(
    `  caps: grant ${xlm(c.maxGrantStroops)}, owner payment ${xlm(c.maxOwnerPaymentStroops)}, x402 ${xlm(c.maxX402PriceStroops)} USDC; payments ${c.paymentsEnabled ? 'on' : 'OFF'}`,
  )
  console.log(
    `  fee ceilings XLM: any ${xlm(n.fees.maxFeeStroops)}, first pull ${xlm(n.fees.firstPullMaxFeeStroops)}, pull ${xlm(n.fees.pullMaxFeeStroops)}, owner ${xlm(n.fees.ownerMaxFeeStroops)}`,
  )
  const w = web.value.wallet
  console.log(
    `  Worker: stage ${web.value.stage.stage}, chain ${w.chain}, rpId ${w.rpId._tag === 'Some' ? w.rpId.value : '(request host)'}, origin ${w.origin._tag === 'Some' ? w.origin.value : '(request)'}, demo contacts ${w.demoContacts.length}, demo claim signer ${w.demoClaimSigner === true ? 'on' : 'off'}`,
  )
  return true
}

const today = await boot('as apps/web/alchemy.run.ts binds the file today', bound)
const routerPending = router === ''
const afterM3 = routerPending
  ? await boot(
      'the same, with ONBOARD_ROUTER_ID set to the precomputed M3 id',
      bindingsOf({ ...file, ONBOARD_ROUTER_ID: routerId() }),
    )
  : today

console.log(`\n${failures.length === 0 ? 'formats ok' : `format failures: ${failures.join('; ')}`}`)
for (const n of notes) console.log(`note: ${n}`)
console.log(
  `boots as bound today: ${today ? 'yes' : routerPending ? 'no, ONBOARD_ROUTER_ID is empty until M3' : 'NO'}${routerPending ? `; once ONBOARD_ROUTER_ID is set: ${afterM3 ? 'yes' : 'NO'}` : ''}`,
)
process.exit(failures.length === 0 && afterM3 ? 0 : 1)
