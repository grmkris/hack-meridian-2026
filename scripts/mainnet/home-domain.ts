import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { type NetworkName, PRESETS } from '../../packages/stellar/src/network.ts'

/**
 * SEP-1, step 2 (HANDOFF item 10): `home_domain` on every relayer and on the treasury of one network, so explorers show
 * the account as Nod's and find /.well-known/stellar.toml on the domain. One classic SetOptions per account, signed by
 * that account, which pays its own 0.001 XLM fee. Refuses unless the domain's stellar.toml already lists the account;
 * skips an account whose home_domain is already the domain, so a rerun is safe.
 *
 *   bun scripts/mainnet/home-domain.ts --network testnet                      # testnet.trynod.si
 *   HM26_MAINNET_GO=yes bun scripts/mainnet/home-domain.ts --network pubnet   # trynod.si, real XLM
 *
 * Keys: apps/web/.env.testnet (testnet stage) or scripts/demo/.env.pubnet (mainnet accounts), mode 600. Only the
 * relayer and treasury lines are read; public keys and transaction hashes are printed, never a secret. Standalone,
 * because ./lib.ts runs on pubnet only.
 */
const ROOT = resolve(import.meta.dir, '../..')
const TARGETS = {
  testnet: { domain: 'testnet.trynod.si', file: 'apps/web/.env.testnet' },
  pubnet: { domain: 'trynod.si', file: 'scripts/demo/.env.pubnet' },
} as const satisfies Record<NetworkName, { domain: string; file: string }>
/**
 * The only lines read: the relayers as the chain package reads them (RELAYER_SECRETS, else RELAYER_SECRET, comma
 * separated), mainnet's relayer B (scripts/demo/.env.pubnet keeps it on its own line) and the treasury.
 */
const NAMES = ['RELAYER_SECRETS', 'RELAYER_SECRET', 'RELAYER_B_SECRET', 'TREASURY_SECRET'] as const
const FEE_STROOPS = '10000'

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

const args = process.argv.slice(2)
const arg = args.includes('--network') ? args[args.indexOf('--network') + 1] : undefined
const network: NetworkName =
  arg === 'testnet' || arg === 'pubnet'
    ? arg
    : fail('usage: bun scripts/mainnet/home-domain.ts --network testnet|pubnet', 2)
if (network === 'pubnet' && process.env['HM26_MAINNET_GO'] !== 'yes')
  fail("refusing: pubnet signs with real accounts. Run with HM26_MAINNET_GO=yes on Kristjan's go.", 2)
const { domain, file } = TARGETS[network]
const params = PRESETS[network]

/** The wanted lines of a mode-600 `NAME=value` file (alchemy.run.ts's format); nothing else is kept. */
function readSecrets(path: string): Partial<Record<(typeof NAMES)[number], string>> {
  if (!existsSync(path)) return fail(`${file} is missing`)
  if ((statSync(path).mode & 0o077) !== 0) fail(`${file} is readable by others; chmod 600 it`)
  const out: Partial<Record<(typeof NAMES)[number], string>> = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim().replace(/^export\s+/u, '')
    const key = NAMES.find(wanted => line.startsWith(`${wanted}=`))
    if (key !== undefined) out[key] = line.slice(key.length + 1).trim()
  }
  return out
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')

/** A secret line's key; the parse error is not printed, as it may quote the input. */
function keypairOf(role: string, secret: string): Stellar.Keypair {
  try {
    return Stellar.Keypair.fromSecret(secret)
  } catch {
    return fail(`a ${role} line in ${file} is not a Stellar secret key`)
  }
}

const env = readSecrets(resolve(ROOT, file))
const relayerLine = list(env.RELAYER_SECRETS).length > 0 ? env.RELAYER_SECRETS : env.RELAYER_SECRET
const signers = new Map<string, { role: string; key: Stellar.Keypair }>()
for (const [role, secrets] of [
  ['relayer', [...list(relayerLine), ...list(env.RELAYER_B_SECRET)]],
  ['treasury', list(env.TREASURY_SECRET)],
] as const)
  for (const secret of secrets) {
    const key = keypairOf(role, secret)
    if (!signers.has(key.publicKey())) signers.set(key.publicKey(), { role, key })
  }
if (signers.size === 0) fail(`no relayer or treasury key in ${file}`)

const tomlUrl = `https://${domain}/.well-known/stellar.toml`
const toml = await fetch(tomlUrl).then(
  response => (response.ok ? response.text() : ''),
  () => '',
)
const servers = [params.rpcUrl, params.rpcFallbackUrl]
  .filter((url): url is string => url !== null && url !== '')
  .map(url => new Stellar.rpc.Server(url))

async function onAnyRpc<A>(
  f: (server: Stellar.rpc.Server) => Promise<A>,
): Promise<{ server: Stellar.rpc.Server; value: A }> {
  let last: unknown
  for (const server of servers) {
    try {
      return { server, value: await f(server) }
    } catch (error) {
      last = error
    }
  }
  throw new Error(`no RPC answered: ${last instanceof Error ? last.message : String(last)}`)
}

const accountKey = (address: string) =>
  Stellar.xdr.LedgerKey.account(
    new Stellar.xdr.LedgerKeyAccount({ accountId: Stellar.Keypair.fromPublicKey(address).xdrAccountId() }),
  )

async function setHomeDomain(address: string, key: Stellar.Keypair): Promise<string> {
  const { server, value } = await onAnyRpc(rpc => rpc.getLedgerEntries(accountKey(address)))
  const entry = value.entries[0]
  if (entry === undefined) throw new Error('not funded')
  const account = entry.val.account()
  if (account.homeDomain().toString() === domain) return 'already set'
  const tx = new Stellar.TransactionBuilder(new Stellar.Account(address, account.seqNum().toString()), {
    fee: FEE_STROOPS,
    networkPassphrase: params.passphrase,
  })
    .addOperation(Stellar.Operation.setOptions({ homeDomain: domain }))
    .setTimeout(120)
    .build()
  tx.sign(key)
  const hash = tx.hash().toString('hex')
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER')
    throw new Error(`${sent.status} ${sent.errorResult?.result().switch().name ?? ''} (${hash})`)
  for (let i = 0; i < 60; i++) {
    await new Promise(done => setTimeout(done, 1_000))
    const got = await server.getTransaction(hash).catch(() => undefined)
    if (got === undefined || got.status === Stellar.rpc.Api.GetTransactionStatus.NOT_FOUND) continue
    if (got.status !== Stellar.rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${got.status} (${hash})`)
    return `${hash} ${params.explorerBase}/tx/${hash}`
  }
  throw new Error(`not final after 60 s; check ${params.explorerBase}/tx/${hash} before rerunning`)
}

console.log(`home_domain ${domain} on ${network} (${signers.size} accounts from ${file})`)
let failed = 0
for (const [address, { role, key }] of signers) {
  if (!toml.includes(`"${address}"`)) {
    console.log(`  ${role} ${address}: refused, ${tomlUrl} does not list it (deploy and check the file first)`)
    failed++
    continue
  }
  try {
    console.log(`  ${role} ${address}: ${await setHomeDomain(address, key)}`)
  } catch (error) {
    console.log(`  ${role} ${address}: failed, ${error instanceof Error ? error.message : String(error)}`)
    failed++
  }
}
process.exit(failed === 0 ? 0 : 1)
