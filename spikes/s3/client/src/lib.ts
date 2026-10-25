// Reusable pieces of the S3 flow (@stellar/stellar-sdk 17.3.0). The build can port these as-is.
//
//   router.pay_and_trust(sender, recipient, token, amount)
//     -> token.trust(recipient)                     recipient's entry, root = this SAC call (only if no trustline)
//     -> token.transfer(sender, recipient, amount)  sender's entry, root = this SAC call
//
// Neither entry is rooted at the transaction's root call, so the first simulation MUST use
// authMode 'record_allow_nonroot' (default 'record' fails with Error(Auth, InvalidAction)).
import {
  Account,
  Address,
  authorizeEntry,
  buildInvocationTree,
  Contract,
  inspectAuthEntry,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  type Keypair,
  type SigningCallback,
  type Transaction,
} from '@stellar/stellar-sdk'

export interface PayAndTrust {
  router: string
  sender: string
  recipient: string
  token: string
  amount: bigint
}

/** Who an auth entry is for and the root call it authorizes (SDK 17 property-style XDR). */
export const describeEntry = (e: xdr.SorobanAuthorizationEntry) => {
  const info = inspectAuthEntry(e)
  const tree = buildInvocationTree(info.invocation)
  const call = 'source' in tree.args ? `${tree.args.source}.${tree.args.function}` : tree.type
  return { who: info.address ?? 'source-account', call, subInvocations: tree.invocations.length, signed: info.signed }
}

/** The invokeHostFunction body for router.pay_and_trust. */
export const payAndTrustFunc = (p: PayAndTrust): xdr.HostFunction => {
  const op = new Contract(p.router).call(
    'pay_and_trust',
    new Address(p.sender).toScVal(),
    new Address(p.recipient).toScVal(),
    new Address(p.token).toScVal(),
    nativeToScVal(p.amount, { type: 'i128' }),
  )
  // SDK 17: XDR structs are plain properties, not accessor methods.
  return (op.body as unknown as { invokeHostFunctionOp: { hostFunction: xdr.HostFunction } }).invokeHostFunctionOp
    .hostFunction
}

/** A fresh tx (relayer = source + fee payer) around func; sequence is not mutated, so it can be rebuilt freely. */
export const buildTx = (
  relayer: string,
  sequence: string,
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  networkPassphrase: string,
): Transaction =>
  new TransactionBuilder(new Account(relayer, sequence), { fee: '100000', networkPassphrase })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(300)
    .build()

/** Step 1: recording simulation that allows non-root auth. Returns the unsigned entries, one per authorizer. */
export const simulateUnsigned = async (server: rpc.Server, tx: Transaction) => {
  const sim = await server.simulateTransaction(tx, undefined, 'record_allow_nonroot')
  if (!rpc.Api.isSimulationSuccess(sim))
    throw new Error(rpc.Api.isSimulationError(sim) ? sim.error : 'simulation failed')
  // sim.minResourceFee here is ~4.65 XLM per auth entry (refundable estimate); never submit with it.
  return { entries: sim.result?.auth ?? [], latestLedger: sim.latestLedger }
}

/**
 * Adapter for a browser wallet's signAuthEntry (Freighter `@stellar/freighter-api`, Stellar Wallets Kit):
 * the wallet receives the HashIdPreimage XDR (base64), hashes it, signs with the account key and returns the
 * signature (base64). UNVERIFIED in a browser in this spike; the keypair path is what ran on testnet.
 */
export const walletSigner =
  (
    signAuthEntry: (
      preimageXdr: string,
      opts: { networkPassphrase: string; address: string },
    ) => Promise<{ signedAuthEntry: string | null; error?: unknown }>,
    address: string,
    networkPassphrase: string,
  ): SigningCallback =>
  async preimage => {
    const res = await signAuthEntry(preimage.toXDR('base64'), { networkPassphrase, address })
    if (res.error || !res.signedAuthEntry) throw new Error(`wallet refused to sign: ${String(res.error)}`)
    return Buffer.from(res.signedAuthEntry, 'base64')
  }

/** Step 2: each authorizer signs only its own entry. signers maps G-address -> Keypair or wallet callback. */
export const signEntries = async (
  entries: xdr.SorobanAuthorizationEntry[],
  signers: Record<string, Keypair | SigningCallback>,
  validUntilLedger: number,
  networkPassphrase: string,
) =>
  Promise.all(
    entries.map(e => {
      const { who } = describeEntry(e)
      const signer = signers[who]
      if (!signer) throw new Error(`no signer for auth entry of ${who}`)
      return authorizeEntry(e, signer, validUntilLedger, networkPassphrase)
    }),
  )

/** Steps 3-4: enforce-mode re-simulation with the signed entries, assemble, relayer signs, send, poll. */
export const submitSigned = async (
  server: rpc.Server,
  relayer: Keypair,
  func: xdr.HostFunction,
  signed: xdr.SorobanAuthorizationEntry[],
  networkPassphrase: string,
) => {
  const seq = (await server.getAccount(relayer.publicKey())).sequenceNumber()
  const tx = buildTx(relayer.publicKey(), seq, func, signed, networkPassphrase)
  const sim = await server.simulateTransaction(tx, undefined, 'enforce')
  if (!rpc.Api.isSimulationSuccess(sim))
    throw new Error(rpc.Api.isSimulationError(sim) ? sim.error : 'enforce simulation failed')
  const assembled = rpc.assembleTransaction(tx, sim).build() // keeps our signed auth entries
  assembled.sign(relayer)
  const sent = await server.sendTransaction(assembled)
  if (sent.status === 'ERROR') throw new Error(`sendTransaction ERROR ${sent.hash}`)
  const final = await server.pollTransaction(sent.hash, { attempts: 30 })
  return { hash: sent.hash, status: final.status, minResourceFee: sim.minResourceFee }
}
