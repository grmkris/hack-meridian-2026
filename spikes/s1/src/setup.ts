/**
 * One-time testnet setup. Generates missing keys into spikes/s1/.env, friendbots the G accounts,
 * adds USDC trustlines (funder, merchant) and buys USDC for the funder on the testnet SDEX
 * (pathPaymentStrictReceive XLM → USDC; this is Circle's real testnet USDC, no faucet needed).
 *
 *   bun src/setup.ts            # idempotent
 *   bun src/setup.ts --buy 60   # buy N more USDC into the funder
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

import { NETWORK_PASSPHRASE, USDC_ISSUER, explorerTx } from './signer'

const ENV = join(import.meta.dir, '..', '.env')
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
const usdc = new Asset('USDC', USDC_ISSUER)

function key(name: string): Keypair {
  const v = `${name}_SECRET`
  const existing = process.env[v] ?? readEnv()[v]
  if (existing) return Keypair.fromSecret(existing)
  const kp = Keypair.random()
  appendFileSync(ENV, `${v}=${kp.secret()}\n`, { mode: 0o600 })
  console.log(`generated ${name}: ${kp.publicKey()}`)
  return kp
}
function readEnv(): Record<string, string> {
  if (!existsSync(ENV)) return {}
  return Object.fromEntries(
    readFileSync(ENV, 'utf8')
      .split('\n')
      .filter(l => l.includes('='))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
}

async function friendbot(kp: Keypair) {
  try {
    await horizon.loadAccount(kp.publicKey())
    return
  } catch {}
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)
  console.log(`friendbot ${kp.publicKey()} → ${r.status}`)
}

async function submit(kp: Keypair, ops: ReturnType<typeof Operation.changeTrust>[], label: string) {
  const acct = await horizon.loadAccount(kp.publicKey())
  const b = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }).setTimeout(60)
  ops.forEach(o => b.addOperation(o))
  const tx = b.build()
  tx.sign(kp)
  const r = await horizon.submitTransaction(tx)
  console.log(`${label}: ${r.hash} ${explorerTx(r.hash)}`)
  return r.hash
}

async function hasTrust(kp: Keypair) {
  const a = await horizon.loadAccount(kp.publicKey())
  return a.balances.find(b => 'asset_code' in b && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER)
}

const names = ['SPONSOR', 'FUNDER', 'OWNER', 'CONN', 'MERCHANT'] as const
const keys = Object.fromEntries(names.map(n => [n, key(n)])) as Record<(typeof names)[number], Keypair>
for (const n of ['SPONSOR', 'FUNDER', 'MERCHANT'] as const) await friendbot(keys[n])
for (const n of ['FUNDER', 'MERCHANT'] as const) {
  if (!(await hasTrust(keys[n])))
    await submit(keys[n], [Operation.changeTrust({ asset: usdc })], `${n} changeTrust USDC`)
}
const buyIdx = process.argv.indexOf('--buy')
const want = buyIdx > 0 ? Number(process.argv[buyIdx + 1]) : 0
const bal = await hasTrust(keys.FUNDER)
if (want > 0 || Number(bal?.balance ?? 0) < 30) {
  const amount = String(want || 60)
  await submit(
    keys.FUNDER,
    [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: '500',
        destination: keys.FUNDER.publicKey(),
        destAsset: usdc,
        destAmount: amount,
        path: [],
      }),
    ],
    `FUNDER buys ${amount} USDC on SDEX`,
  )
}
for (const n of names) {
  const b = await horizon
    .loadAccount(keys[n].publicKey())
    .then(a => a.balances.map(x => `${'asset_code' in x ? x.asset_code : 'XLM'}=${x.balance}`).join(' '))
    .catch(() => '(not funded)')
  console.log(`${n.padEnd(8)} ${keys[n].publicKey()} ${b}`)
}
