import { Stellar } from '../../apps/seller/demo-deps.ts'
import { USDC, announce, args, classicOps, explorerTx, keypair, toStroops } from './lib.ts'

/**
 * One classic USDC payment from the mainnet treasury to a G… (no memo), the way an exchange or any classic wallet pays:
 * the deposit-address test sends 1 USDC to a Nod deposit address with it. The treasury pays its own 0.001 XLM fee.
 *
 *   bun scripts/mainnet/pay-classic.ts <G…> <usdc>                      prints what it would send (no go)
 *   HM26_MAINNET_GO=yes bun scripts/mainnet/pay-classic.ts <G…> <usdc>  on the orchestrator's go
 */
const [destination = '', amount = ''] = args.filter(arg => !arg.startsWith('--'))
if (!Stellar.StrKey.isValidEd25519PublicKey(destination)) throw new Error(`not a G… address: ${destination}`)
if (!/^\d+(\.\d{1,7})?$/u.test(amount) || toStroops(amount) <= 0n) throw new Error(`not an amount: ${amount}`)

const mode = announce(`classic payment of ${amount} USDC to ${destination}`, [
  { what: `pay ${amount} USDC (no memo)`, payer: 'treasury', xlm: 0.001, usdc: Number(amount) },
])
const sent = await classicOps({
  label: `${amount} USDC to ${destination.slice(0, 8)}…`,
  source: keypair('treasury'),
  ops: [Stellar.Operation.payment({ destination, asset: USDC, amount })],
  submit: mode === 'submit',
})
if (sent !== undefined)
  console.log(JSON.stringify({ hash: sent.hash, ledger: sent.ledger, explorer: explorerTx(sent.hash) }))
