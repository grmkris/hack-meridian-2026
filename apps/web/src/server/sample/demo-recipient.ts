import { Effect, Option, Schema } from 'effect'

import { TESTNET } from '@hm/stellar'
import { Account, Asset, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

/**
 * Testnet only: put the seeded demo recipient (Carol) back to "has never held USDC", so every sample run (and every
 * judge's own claim) finds her without a trustline. One classic transaction signed by DEMO_RECIPIENT_SECRET, the key
 * the claim page's `?demo=1` path already signs with: her whole USDC balance back to the treasury, then ChangeTrust to
 * limit 0. Carol pays its classic fee (~0.0002 XLM) from her own XLM, so no relayer key leaves the chain package.
 */
export class ResetError extends Schema.TaggedError<ResetError>()('ResetError', { message: Schema.String }) {}

export interface RecipientReset {
  /** Null when she has no USDC trustline (nothing to do); else the transaction and the USDC returned. */
  readonly reset: (
    address: string,
    returnTo: string,
  ) => Effect.Effect<{ readonly tx: string; readonly returned: string } | null, ResetError>
}

/** Stages without the demo recipient's key (the fixture chain): the run reports why it skips the claim. */
export const noRecipientReset = (why: string): RecipientReset => ({
  reset: () => Effect.fail(new ResetError({ message: why })),
})

const HorizonAccount = Schema.Struct({
  sequence: Schema.String,
  balances: Schema.Array(
    Schema.Struct({
      asset_type: Schema.String,
      asset_code: Schema.optionalKey(Schema.String),
      asset_issuer: Schema.optionalKey(Schema.String),
      balance: Schema.String,
    }),
  ),
})
const HorizonSubmit = Schema.Struct({ hash: Schema.String, successful: Schema.Boolean })
const HorizonProblem = Schema.Struct({
  extras: Schema.Struct({ result_codes: Schema.Struct({ transaction: Schema.optionalKey(Schema.String) }) }),
})

const failure = (message: string) => new ResetError({ message })
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

const horizonJson = (fetchImpl: typeof fetch, path: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(`${TESTNET.horizonUrl}${path}`, init)
      const body: unknown = await response.json()
      return { status: response.status, body }
    },
    catch: cause => failure(`Horizon ${path}: ${String(cause)}`),
  })

export const horizonRecipientReset = (secret: string, fetchImpl: typeof fetch): RecipientReset => ({
  reset: (address, returnTo) =>
    Effect.gen(function* () {
      const keypair = yield* Effect.try({
        try: () => Keypair.fromSecret(secret),
        catch: () => failure('DEMO_RECIPIENT_SECRET is not a Stellar secret key'),
      })
      if (keypair.publicKey() !== address)
        return yield* failure(
          `the demo recipient key belongs to ${short(keypair.publicKey())}, not Carol (${short(address)}); align DEMO_RECIPIENT_SECRET and the seeds`,
        )
      const loaded = yield* horizonJson(fetchImpl, `/accounts/${address}`)
      const account = yield* Schema.decodeUnknownEffect(HorizonAccount)(loaded.body).pipe(
        Effect.mapError(() => failure(`Horizon has no account ${short(address)} (HTTP ${loaded.status})`)),
      )
      const usdc = account.balances.find(
        balance => balance.asset_code === 'USDC' && balance.asset_issuer === TESTNET.usdcIssuer,
      )
      if (usdc === undefined) return null
      const asset = new Asset('USDC', TESTNET.usdcIssuer)
      const builder = new TransactionBuilder(new Account(address, account.sequence), {
        fee: '1000',
        networkPassphrase: TESTNET.passphrase,
      })
      if (Number(usdc.balance) > 0)
        builder.addOperation(Operation.payment({ destination: returnTo, asset, amount: usdc.balance }))
      const tx = builder
        .addOperation(Operation.changeTrust({ asset, limit: '0' }))
        .setTimeout(60)
        .build()
      tx.sign(keypair)
      const sent = yield* horizonJson(fetchImpl, '/transactions', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx: tx.toXDR() }).toString(),
      })
      const done = Schema.decodeUnknownOption(HorizonSubmit)(sent.body)
      if (Option.isSome(done) && done.value.successful) return { tx: done.value.hash, returned: usdc.balance }
      const code = Option.match(Schema.decodeUnknownOption(HorizonProblem)(sent.body), {
        onNone: () => `HTTP ${sent.status}`,
        onSome: problem => problem.extras.result_codes.transaction ?? `HTTP ${sent.status}`,
      })
      return yield* failure(`Stellar refused Carol's reset (${code})`)
    }),
})
