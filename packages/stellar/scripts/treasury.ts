/**
 * Testnet accounts for the chain package: relayers (source + fee payer of every transaction), the treasury (holds
 * Circle testnet USDC for `fundNewWallet`, the judge path's 10 USDC), the vault key, and the demo claim recipient
 * ("Carol": a funded G account with no USDC trustline). Idempotent: creates what is missing, tops up what is low.
 *
 *   bun packages/stellar/scripts/treasury.ts                  # create/fund; buy USDC up to 50 in the treasury
 *   bun packages/stellar/scripts/treasury.ts --usdc 200       # treasury target balance in USDC
 *   bun packages/stellar/scripts/treasury.ts --relayers 3     # how many relayers (default 2)
 *   bun packages/stellar/scripts/treasury.ts --new-carol      # replace the demo recipient (after a claim used it)
 *
 * Secrets go to packages/stellar/.env (gitignored, mode 600) and are never printed; public keys and hashes are.
 * USDC is bought on the testnet SDEX (XLM → Circle USDC, `pathPaymentStrictReceive`), as spikes S1–S3 did.
 *
 * The Worker gets the same values as secrets through apps/web/alchemy.run.ts, which reads `apps/web/.env.<stage>`:
 *
 *   grep -E '^(RELAYER_SECRET|TREASURY_SECRET|VAULT_KEY|DEMO_RECIPIENT_SECRET)=' packages/stellar/.env \
 *     >> apps/web/.env.testnet && chmod 600 apps/web/.env.testnet
 *
 * (`RELAYER_SECRET` holds all relayers, comma-separated; the chain package splits it.) Keep the vault key stable:
 * connection keys sealed under one VAULT_KEY cannot be opened with another.
 */
import { Asset, Keypair, Networks, Operation, rpc, TransactionBuilder } from '@stellar/stellar-sdk'

import { toBase64Url } from '../src/bytes.ts'
import { TESTNET_FRIENDBOT_URL, TESTNET_RPC_URL, USDC_CODE, USDC_ISSUER } from '../src/constants.ts'

const ENV_PATH = new URL('../.env', import.meta.url).pathname
const args = Bun.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const targetUsdc = Number(flag('--usdc') ?? '50')
const relayerCount = Number(flag('--relayers') ?? '2')
const usdc = new Asset(USDC_CODE, USDC_ISSUER)
const server = new rpc.Server(Bun.env['STELLAR_RPC_URL'] ?? TESTNET_RPC_URL)

const readEnv = async (): Promise<Map<string, string>> => {
  const file = Bun.file(ENV_PATH)
  const text = (await file.exists()) ? await file.text() : ''
  return new Map(
    text
      .split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()] as const),
  )
}

const writeEnv = async (env: Map<string, string>) => {
  const lines = ['# packages/stellar/.env: testnet secrets for the chain package (scripts/treasury.ts). Never commit.']
  for (const [k, v] of env) lines.push(`${k}=${v}`)
  await Bun.write(ENV_PATH, `${lines.join('\n')}\n`)
  Bun.spawnSync(['chmod', '600', ENV_PATH])
}

const exists = async (address: string) =>
  server.getAccount(address).then(
    () => true,
    () => false,
  )

const friendbot = async (address: string) => {
  if (await exists(address)) return
  const res = await fetch(`${TESTNET_FRIENDBOT_URL}?addr=${address}`)
  console.log(`friendbot ${address}: ${res.status}`)
  for (let i = 0; i < 15 && !(await exists(address)); i++) await Bun.sleep(1000)
}

const balances = async (address: string) => {
  const entry = await server.getAccountEntry(address).catch(() => undefined)
  const line = await server.getTrustline(address, usdc).catch(() => undefined)
  return {
    xlm: entry === undefined ? 0 : Number(entry.balance().toString()) / 1e7,
    usdc: line === undefined ? undefined : Number(line.balance().toString()) / 1e7,
  }
}

const submit = async (source: Keypair, ops: ReadonlyArray<ReturnType<typeof Operation.payment>>, label: string) => {
  const account = await server.getAccount(source.publicKey())
  const builder = new TransactionBuilder(account, { fee: '1000', networkPassphrase: Networks.TESTNET })
  for (const op of ops) builder.addOperation(op)
  const tx = builder.setTimeout(60).build()
  tx.sign(source)
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') throw new Error(`${label}: rejected ${sent.errorResult?.result().switch().name}`)
  const done = await server.pollTransaction(sent.hash, { attempts: 30 })
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${label}: ${done.status} ${sent.hash}`)
  console.log(`${label}: https://stellar.expert/explorer/testnet/tx/${sent.hash}`)
}

const env = await readEnv()
const keypair = (name: string, fresh = false) => {
  const existing = env.get(name)
  if (existing !== undefined && !fresh) return Keypair.fromSecret(existing)
  const kp = Keypair.random()
  env.set(name, kp.secret())
  return kp
}

const relayerSecrets = (env.get('RELAYER_SECRET') ?? '').split(',').filter(s => s.length > 0)
while (relayerSecrets.length < relayerCount) relayerSecrets.push(Keypair.random().secret())
env.set('RELAYER_SECRET', relayerSecrets.join(','))
const relayers = relayerSecrets.map(s => Keypair.fromSecret(s))
const treasury = keypair('TREASURY_SECRET')
const carol = keypair('DEMO_RECIPIENT_SECRET', args.includes('--new-carol'))
if (!env.has('VAULT_KEY')) env.set('VAULT_KEY', toBase64Url(crypto.getRandomValues(new Uint8Array(32))))
await writeEnv(env)

for (const kp of [...relayers, treasury, carol]) await friendbot(kp.publicKey())

const t = await balances(treasury.publicKey())
if (t.usdc === undefined) await submit(treasury, [Operation.changeTrust({ asset: usdc })], 'treasury USDC trustline')
const have = (await balances(treasury.publicKey())).usdc ?? 0
if (have < targetUsdc) {
  const buy = (targetUsdc - have).toFixed(7)
  await submit(
    treasury,
    [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: String(Math.ceil(Number(buy) * 3) + 10),
        destination: treasury.publicKey(),
        destAsset: usdc,
        destAmount: buy,
        path: [],
      }),
    ],
    `treasury buys ${buy} USDC on the SDEX`,
  )
}

for (const [role, kp] of [
  ...relayers.map((r, i) => [`relayer ${i + 1}`, r] as const),
  ['treasury', treasury] as const,
  ['demo recipient', carol] as const,
]) {
  const b = await balances(kp.publicKey())
  console.log(
    `${role.padEnd(15)} ${kp.publicKey()}  XLM ${b.xlm.toFixed(2)}  USDC ${b.usdc === undefined ? '(no trustline)' : b.usdc.toFixed(2)}`,
  )
}
console.log(`secrets: ${ENV_PATH} (RELAYER_SECRET, TREASURY_SECRET, VAULT_KEY, DEMO_RECIPIENT_SECRET)`)
