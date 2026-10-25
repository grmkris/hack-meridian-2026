import { sacBalances, sacTransfer } from './lib/chain.ts'
import { explorerAddress, key, stroops, usdc } from './lib/env.ts'

/**
 * Sends testnet USDC from the TREASURY to any address (a demo wallet's C…, a G with a trustline) through the USDC
 * SAC; the treasury is source and fee payer. For rehearsals and the recording, when 10 USDC of auto-funding is not
 * enough for the 100 USDC dinner beat.
 *
 *   bun scripts/demo/fund.ts <C…|G…> <usdc>
 */
const [to, amount] = process.argv.slice(2)
if (to === undefined || amount === undefined || !/^\d+(\.\d{1,7})?$/u.test(amount))
  throw new Error('usage: bun scripts/demo/fund.ts <C…|G…> <usdc amount>')
const treasury = key('TREASURY', false)
const sent = await sacTransfer(treasury, to, stroops(amount), `TREASURY → ${to.slice(0, 6)}… ${amount} USDC`)
const after = await sacBalances(treasury.publicKey(), to)
console.log(`${to} now holds ${usdc(after.usdc)} USDC (${explorerAddress(to)}); tx ledger ${sent.ledger}`)
