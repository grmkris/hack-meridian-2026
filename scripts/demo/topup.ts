import { sacBalances, sacTransfer } from './lib/chain.ts'
import { NETWORK, explorerAddress, explorerTx, key, stroops, usdc } from './lib/env.ts'

/**
 * Moves USDC from the TREASURY (scripts/demo/.env) to any wallet address (a Nod wallet's C…, or a G with a USDC
 * trustline) with a USDC SAC transfer; the treasury is source and fee payer. For the recording wallet: the welcome
 * funding gives 10 USDC and the video needs 30, so `… 20`. Pubnet is refused unless HM26_MAINNET_GO=yes.
 *
 *   bun scripts/demo/topup.ts [--target testnet] [--network testnet|pubnet] <C…|G…> <usdc>
 *
 * `--target` only names the stage for the log; the treasury and network are what move the money.
 */
const args = process.argv.slice(2)
const positional = args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
const [to, amount] = positional
if (to === undefined || amount === undefined || !/^[CG][A-Z2-7]{55}$/u.test(to) || !/^\d+(\.\d{1,7})?$/u.test(amount))
  throw new Error('usage: bun scripts/demo/topup.ts [--target testnet] <C…|G…> <usdc amount>')
const treasury = key('TREASURY', false)
const before = await sacBalances(treasury.publicKey(), to)
const sent = await sacTransfer(
  treasury,
  to,
  stroops(amount),
  `treasury → ${to.slice(0, 6)}… ${amount} USDC on ${NETWORK}`,
)
const after = await sacBalances(treasury.publicKey(), to)
console.log(`tx ${sent.hash}`)
console.log(`explorer ${explorerTx(sent.hash)}`)
console.log(`${to}: ${usdc(before.usdc)} → ${usdc(after.usdc)} USDC (${explorerAddress(to)}), ledger ${sent.ledger}`)
