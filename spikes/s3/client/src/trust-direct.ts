// Usage: bun src/trust-direct.ts <role>
// SAC trust(addr) called directly with Contract.call (no router), relayer = source + fee payer, <role> signs its entry.
// Shows the plain SDK path; contract.Client.from(SAC) in SDK 17.3.0 has no `trust` method (its SAC_SPEC predates CAP-73).
import { Address, Contract, rpc, xdr } from '@stellar/stellar-sdk'

import { expert, key, PASSPHRASE, server, USDC_SAC } from './env'
import { buildTx, describeEntry, signEntries, submitSigned } from './lib'

const relayer = key('relayer')
const who = key(process.argv[2] ?? 'recipient_direct')
const op = new Contract(USDC_SAC).call('trust', new Address(who.publicKey()).toScVal())
const func = (op.body as unknown as { invokeHostFunctionOp: { hostFunction: xdr.HostFunction } }).invokeHostFunctionOp
  .hostFunction
const seq = (await server.getAccount(relayer.publicKey())).sequenceNumber()
// Root-level auth here, so the default recording mode works.
const sim = await server.simulateTransaction(buildTx(relayer.publicKey(), seq, func, [], PASSPHRASE))
if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(rpc.Api.isSimulationError(sim) ? sim.error : 'sim failed')
const entries = sim.result?.auth ?? []
console.log('entries:', entries.map(describeEntry))
const signed = await signEntries(entries, { [who.publicKey()]: who }, sim.latestLedger + 60, PASSPHRASE)
const res = await submitSigned(server, relayer, func, signed, PASSPHRASE)
console.log(`${res.status} ${expert(res.hash)}`)
