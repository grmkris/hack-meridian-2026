import { Effect, Layer, Option, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

import { Chain, ChainError, type ChainShape, type PreparedOwnerAuth, type Receipt, type X402Quote } from './chain.ts'
import { USDC_SAC } from './entities.ts'

/**
 * A deterministic, in-memory `Chain` so the service runs and its tests pass without testnet. It keeps balances, rules
 * and their spending, and refuses what the real chain refuses with the same error kinds: a transfer over the rule's
 * remaining limit fails `limit_exhausted` (S1 `#3221`) without changing anything, a removed rule `removed`, and a
 * passkey assertion whose clientDataJSON challenge differs from the prepared one `simulation_failed` (the digest binds
 * recipient and amount). Every call is logged for tests.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const strkey = (prefix: 'C' | 'G', n: number, tag: string, seed = ''): string => {
  let body = ''
  let rest = n
  do {
    body = `${BASE32[rest % 32] ?? 'A'}${body}`
    rest = Math.floor(rest / 32)
  } while (rest > 0)
  const head = `${prefix}${tag}${seed}`
  return `${head}${'A'.repeat(56 - head.length - body.length)}${body}`
}

/** Eight random base32 characters: keeps ids unique across fixture instances (isolate restarts). */
const randomSeed = () => [...crypto.getRandomValues(new Uint8Array(8))].map(byte => BASE32[byte % 32] ?? 'A').join('')

/** FNV-1a over a string, as 32 bytes (eight rounds with different seeds): deterministic, not cryptographic. */
const digest = (text: string): Uint8Array => {
  const out = new Uint8Array(32)
  for (let round = 0; round < 8; round++) {
    let h = 0x811c9dc5 ^ round
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    out[round * 4] = h >>> 24
    out[round * 4 + 1] = (h >>> 16) & 0xff
    out[round * 4 + 2] = (h >>> 8) & 0xff
    out[round * 4 + 3] = h & 0xff
  }
  return out
}

const ClientData = Schema.fromJsonString(Schema.Struct({ challenge: Schema.String }))
const decodeClientData = Schema.decodeUnknownOption(ClientData)

const InstallPayload = Schema.fromJsonString(
  Schema.Struct({ signer: Schema.String, limit: Schema.String, lifetimeSeconds: Schema.Finite }),
)
const TransferPayload = Schema.fromJsonString(Schema.Struct({ to: Schema.String, amount: Schema.String }))
const RemovePayload = Schema.fromJsonString(Schema.Struct({ ruleId: Schema.Int }))

export interface FixtureRule {
  readonly contractId: string
  readonly ruleId: number
  readonly signer: string
  readonly limit: bigint
  spent: bigint
  removed: boolean
  readonly validUntilLedger: number
}

export interface FixtureCall {
  readonly method: keyof ChainShape
  readonly args: ReadonlyArray<unknown>
}

export interface FixtureOptions {
  /** `G…` addresses that exist without a USDC trustline. */
  readonly trustlineMissing?: ReadonlyArray<string>
  /** `G…` addresses that do not exist. */
  readonly accountsMissing?: ReadonlyArray<string>
  /** Price the fixture seller asks, in stroops (default 0.10 USDC). A URL with `free` in it answers without a 402. */
  readonly x402PriceStroops?: bigint
  /** Fail the next calls of these methods with this kind (e.g. `{ delegatedTransfer: 'submit_failed' }`). */
  readonly failNext?: Partial<Record<keyof ChainShape, ChainError['kind']>>
  /**
   * For a long-running dev stage whose isolate restarts lose the in-memory ledger: an unknown contract starts with
   * 50 USDC and an unknown rule is live with no onchain limit (the service's own lane check still applies).
   */
  readonly lenient?: boolean
}

export interface FixtureChain {
  readonly chain: ChainShape
  readonly calls: () => ReadonlyArray<FixtureCall>
  readonly callsOf: (method: keyof ChainShape) => ReadonlyArray<FixtureCall>
  readonly rules: () => ReadonlyArray<FixtureRule>
  readonly balanceOf: (address: string) => bigint
  /** Fail the next call of `method` with `kind`. */
  readonly failNext: (method: keyof ChainShape, kind: ChainError['kind']) => void
}

const FIXTURE_LEDGER_START = 1_000_000
const fail = (kind: ChainError['kind'], message: string) => Effect.fail(new ChainError({ kind, message }))
const unreadable = () => new ChainError({ kind: 'unknown', message: 'fixture: unreadable payload' })
const checkAssertion = (prep: PreparedOwnerAuth, clientDataJSON: Uint8Array) =>
  Option.match(decodeClientData(new TextDecoder().decode(clientDataJSON)), {
    onNone: () => fail('simulation_failed', 'fixture: clientDataJSON is not JSON with a challenge'),
    onSome: data =>
      data.challenge === prep.challenge
        ? Effect.void
        : fail('simulation_failed', 'fixture: the assertion signs a different challenge than the prepared entry'),
  })

/** The fixture's signer ref is `fixture:<G address>`; the pocket is that address. */
const pocketOf = (signerKeyRef: string) => signerKeyRef.replace(/^fixture:/u, '')
export const FIXTURE_RELAYER = strkey('G', 1, 'RELAYER')
export const FIXTURE_FACILITATOR = strkey('G', 1, 'FACILITATOR')
export const FIXTURE_SELLER = strkey('G', 1, 'SELLER')

/** Base64url of the challenge a fixture assertion must carry; tests build their assertions with it. */
export const fixtureAssertion = (challenge: string) => ({
  authenticatorData: new Uint8Array(37),
  clientDataJSON: new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge })),
  signature: new Uint8Array(70),
})

export const makeFixtureChain = (options: FixtureOptions = {}): FixtureChain => {
  let counter = 0
  let ledger = FIXTURE_LEDGER_START
  const log: Array<FixtureCall> = []
  const balances = new Map<string, bigint>()
  const rules: Array<FixtureRule> = []
  const nextRuleId = new Map<string, number>()
  const failures = new Map<keyof ChainShape, ChainError['kind']>(
    Object.entries(options.failNext ?? {}).filter(
      // SAFETY: Object.entries widens the keys of a Partial<Record<keyof ChainShape, …>> to string.
      (entry): entry is [keyof ChainShape, ChainError['kind']] => entry[1] !== undefined,
    ),
  )
  const trustlineMissing = new Set(options.trustlineMissing ?? [])
  // Strict fixtures are fully deterministic; a lenient (dev stage) one is reborn with every isolate, so its ids carry
  // a random seed or a second wallet would collide with the first.
  const seed = options.lenient === true ? randomSeed() : ''
  const accountsMissing = new Set(options.accountsMissing ?? [])
  const price = options.x402PriceStroops ?? 1_000_000n

  const next = () => ++counter
  const txHash = () => next().toString(16).padStart(64, '0')
  const balance = (address: string) =>
    balances.get(address) ?? (options.lenient === true && address.startsWith('C') ? 2_000_000_000n : 0n)
  const credit = (address: string, amount: bigint) => balances.set(address, balance(address) + amount)
  const receipt = (feePayer = FIXTURE_RELAYER, feeStroops = 15_000_000n): Receipt => {
    const tx = txHash()
    ledger += 1
    return { tx, ledger, feeStroops, feePayer, explorer: `https://stellar.expert/explorer/testnet/tx/${tx}` }
  }

  /** Log the call, then fail it if a failure was queued for that method. */
  const call = <A>(
    method: keyof ChainShape,
    args: ReadonlyArray<unknown>,
    body: () => Effect.Effect<A, ChainError>,
  ): Effect.Effect<A, ChainError> =>
    Effect.suspend(() => {
      log.push({ method, args })
      const queued = failures.get(method)
      if (queued !== undefined) {
        failures.delete(method)
        return fail(queued, `fixture: queued ${queued} for ${method}`)
      }
      return body()
    })

  const prepared = (kind: PreparedOwnerAuth['kind'], contractId: string, payload: string): PreparedOwnerAuth => {
    const nonce = next()
    return {
      kind,
      contractId,
      challenge: Base64Url.encode(digest(`${kind}|${contractId}|${payload}|${nonce}`)),
      validUntilLedger: ledger + 400,
      entryXdr: `fixture-entry-${nonce}`,
      payload,
    }
  }

  const ruleOf = (contractId: string, ruleId: number) => {
    const found = rules.find(rule => rule.contractId === contractId && rule.ruleId === ruleId)
    if (found !== undefined || options.lenient !== true) return found
    const adopted: FixtureRule = {
      contractId,
      ruleId,
      signer: 'unknown',
      limit: 2n ** 62n,
      spent: 0n,
      removed: false,
      validUntilLedger: ledger + 1_000_000,
    }
    rules.push(adopted)
    return adopted
  }

  const x402Quote = (resource: string): X402Quote => ({
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: USDC_SAC,
    amountStroops: price,
    payTo: FIXTURE_SELLER,
    resource,
    maxTimeoutSeconds: 60,
  })

  const settle = (pocket: string, quote: X402Quote) =>
    Effect.suspend(() => {
      if (balance(pocket) < quote.amountStroops)
        return fail('insufficient_balance', `fixture: pocket ${pocket} holds less than the price`)
      credit(pocket, -quote.amountStroops)
      credit(quote.payTo, quote.amountStroops)
      return Effect.succeed(receipt(FIXTURE_FACILITATOR, 22_000n))
    })

  const chain: ChainShape = {
    deployAccount: ownerPasskey =>
      call('deployAccount', [ownerPasskey], () =>
        Effect.sync(() => {
          const contractId = strkey('C', next(), 'WALLET', seed)
          nextRuleId.set(contractId, 1)
          return { contractId, tx: receipt().tx }
        }),
      ),
    fundNewWallet: (contractId, usdc) =>
      call('fundNewWallet', [contractId, usdc], () =>
        Effect.sync(() => {
          credit(contractId, usdc)
          return { tx: receipt().tx }
        }),
      ),
    newSigner: Effect.suspend(() =>
      call('newSigner', [], () =>
        Effect.sync(() => {
          const address = strkey('G', next(), 'SIGNER', seed)
          return { signerKeyRef: `fixture:${address}`, publicKey: digest(address), address }
        }),
      ),
    ),
    prepareInstallGrant: (contractId, signerPub, limitStroops, lifetimeSeconds) =>
      call('prepareInstallGrant', [contractId, signerPub, limitStroops, lifetimeSeconds], () =>
        Effect.succeed(
          prepared(
            'install_grant',
            contractId,
            JSON.stringify({ signer: Base64Url.encode(signerPub), limit: limitStroops.toString(), lifetimeSeconds }),
          ),
        ),
      ),
    installGrant: (prep, assertion) =>
      call('installGrant', [prep, assertion], () =>
        Effect.gen(function* () {
          yield* checkAssertion(prep, assertion.clientDataJSON)
          const payload = yield* Schema.decodeEffect(InstallPayload)(prep.payload).pipe(Effect.mapError(unreadable))
          const ruleId = nextRuleId.get(prep.contractId) ?? 1
          nextRuleId.set(prep.contractId, ruleId + 1)
          const validUntilLedger = ledger + Math.ceil(payload.lifetimeSeconds / 5)
          rules.push({
            contractId: prep.contractId,
            ruleId,
            signer: payload.signer,
            limit: BigInt(payload.limit),
            spent: 0n,
            removed: false,
            validUntilLedger,
          })
          return { ruleId, validUntilLedger, tx: receipt().tx }
        }),
      ),
    prepareRemoveGrant: (contractId, ruleId) =>
      call('prepareRemoveGrant', [contractId, ruleId], () =>
        Effect.succeed(prepared('remove_grant', contractId, JSON.stringify({ ruleId }))),
      ),
    removeGrant: (prep, assertion) =>
      call('removeGrant', [prep, assertion], () =>
        Effect.gen(function* () {
          yield* checkAssertion(prep, assertion.clientDataJSON)
          const { ruleId } = yield* Schema.decodeEffect(RemovePayload)(prep.payload).pipe(Effect.mapError(unreadable))
          const rule = ruleOf(prep.contractId, ruleId)
          if (rule === undefined || rule.removed) return yield* fail('removed', 'fixture: no such live rule')
          rule.removed = true
          return { tx: receipt().tx }
        }),
      ),
    readGrant: (contractId, ruleId) =>
      call('readGrant', [contractId, ruleId], () =>
        Effect.suspend(() => {
          const rule = ruleOf(contractId, ruleId)
          if (rule === undefined) return fail('removed', 'fixture: no such rule')
          return Effect.succeed({
            spent: rule.spent,
            limit: rule.limit,
            validUntilLedger: rule.validUntilLedger,
            live: !rule.removed && rule.validUntilLedger >= ledger,
          })
        }),
      ),
    prepareOwnerTransfer: (contractId, to, amountStroops, validForLedgers) =>
      call('prepareOwnerTransfer', [contractId, to, amountStroops, validForLedgers], () =>
        Effect.succeed(
          prepared('owner_transfer', contractId, JSON.stringify({ to, amount: amountStroops.toString() })),
        ),
      ),
    finalizeOwnerTransfer: (prep, assertion) =>
      call('finalizeOwnerTransfer', [prep, assertion], () =>
        Effect.gen(function* () {
          yield* checkAssertion(prep, assertion.clientDataJSON)
          const { to, amount } = yield* Schema.decodeEffect(TransferPayload)(prep.payload).pipe(
            Effect.mapError(unreadable),
          )
          const value = BigInt(amount)
          if (balance(prep.contractId) < value) return yield* fail('insufficient_balance', 'fixture: SAC #10')
          credit(prep.contractId, -value)
          credit(to, value)
          return receipt(FIXTURE_RELAYER, 20_000n)
        }),
      ),
    delegatedTransfer: (contractId, ruleId, signerKeyRef, to, amountStroops) =>
      call('delegatedTransfer', [contractId, ruleId, signerKeyRef, to, amountStroops], () =>
        Effect.suspend(() => {
          const rule = ruleOf(contractId, ruleId)
          if (rule === undefined || rule.removed) return fail('removed', 'fixture: #3000 rule removed')
          if (rule.validUntilLedger < ledger) return fail('expired', 'fixture: #3002 rule expired')
          if (rule.spent + amountStroops > rule.limit)
            return fail('limit_exhausted', 'fixture: #3221 spending limit exhausted')
          if (balance(contractId) < amountStroops) return fail('insufficient_balance', 'fixture: SAC #10')
          rule.spent += amountStroops
          credit(contractId, -amountStroops)
          credit(to, amountStroops)
          return Effect.succeed(receipt())
        }),
      ),
    createPocket: signerKeyRef =>
      call('createPocket', [signerKeyRef], () =>
        Effect.sync(() => ({ address: pocketOf(signerKeyRef), tx: receipt().tx })),
      ),
    sweepPocket: (signerKeyRef, toContractId) =>
      call('sweepPocket', [signerKeyRef, toContractId], () =>
        Effect.sync(() => {
          const pocket = pocketOf(signerKeyRef)
          credit(toContractId, balance(pocket))
          balances.set(pocket, 0n)
          return receipt()
        }),
      ),
    payX402: (signerKeyRef, url, maxAmountStroops, paymentId, onQuote) =>
      call('payX402', [signerKeyRef, url, maxAmountStroops, paymentId], () =>
        Effect.gen(function* () {
          if (url.includes('free'))
            return { body: Response.json({ content: 'fixture free resource' }), settlement: null, quote: null }
          const quote = x402Quote(url)
          if (quote.amountStroops > maxAmountStroops)
            return yield* fail('declined', 'fixture: price above the per-payment cap')
          yield* onQuote(quote)
          const settlement = yield* settle(pocketOf(signerKeyRef), quote)
          return {
            body: Response.json({ content: 'fixture paid resource', payment_id: paymentId }),
            settlement,
            quote,
          }
        }),
      ),
    payX402Mcp: (signerKeyRef, mcpUrl, tool, args, maxAmountStroops, paymentId, onQuote) =>
      call('payX402Mcp', [signerKeyRef, mcpUrl, tool, args, maxAmountStroops, paymentId], () =>
        Effect.gen(function* () {
          const quote = x402Quote(`${mcpUrl}#${tool}`)
          if (quote.amountStroops > maxAmountStroops)
            return yield* fail('declined', 'fixture: price above the per-payment cap')
          yield* onQuote(quote)
          const settlement = yield* settle(pocketOf(signerKeyRef), quote)
          return {
            result: { content: [{ type: 'text', text: `fixture result of ${tool}` }] },
            settlement,
            quote,
          }
        }),
      ),
    balances: address =>
      call('balances', [address], () =>
        Effect.succeed({ usdc: balance(address), xlm: address.startsWith('C') ? 0n : 15_000_000n }),
      ),
    readiness: address =>
      call('readiness', [address], () =>
        Effect.succeed(
          address.startsWith('C')
            ? ('contract' as const)
            : accountsMissing.has(address)
              ? ('account_missing' as const)
              : trustlineMissing.has(address)
                ? ('trustline_required' as const)
                : ('usdc_ready' as const),
        ),
      ),
    prepareClaim: (sender, recipient, amountStroops, validForLedgers) =>
      call('prepareClaim', [sender, recipient, amountStroops, validForLedgers], () =>
        Effect.sync(() => {
          const nonce = next()
          return {
            sender,
            recipient,
            amountStroops,
            validUntilLedger: ledger + validForLedgers,
            recipientEntryXdr: `fixture-trust-${nonce}`,
            senderEntryXdr: `fixture-transfer-${nonce}`,
            senderChallenge: Base64Url.encode(digest(`claim|${sender}|${recipient}|${amountStroops}|${nonce}`)),
            payload: '{}',
          }
        }),
      ),
    signClaimAsDemoRecipient: prep =>
      call('signClaimAsDemoRecipient', [prep], () => Effect.succeed(`${prep.recipientEntryXdr}-signed-demo`)),
    finalizeClaim: (prep, recipientSignedEntryXdr, sender) =>
      call('finalizeClaim', [prep, recipientSignedEntryXdr, sender], () =>
        Effect.gen(function* () {
          if (!recipientSignedEntryXdr.startsWith(prep.recipientEntryXdr))
            return yield* fail('simulation_failed', 'fixture: the recipient signed a different entry')
          if (sender._tag === 'Delegated') {
            const rule = ruleOf(prep.sender, sender.ruleId)
            if (rule === undefined || rule.removed) return yield* fail('removed', 'fixture: #3000')
            if (rule.spent + prep.amountStroops > rule.limit) return yield* fail('limit_exhausted', 'fixture: #3221')
            rule.spent += prep.amountStroops
          } else {
            const data = decodeClientData(new TextDecoder().decode(sender.assertion.clientDataJSON))
            if (Option.isNone(data) || data.value.challenge !== prep.senderChallenge)
              return yield* fail('simulation_failed', 'fixture: the passkey signed a different claim')
          }
          if (balance(prep.sender) < prep.amountStroops) return yield* fail('insufficient_balance', 'fixture: #10')
          credit(prep.sender, -prep.amountStroops)
          credit(prep.recipient, prep.amountStroops)
          trustlineMissing.delete(prep.recipient)
          return receipt()
        }),
      ),
    health: Effect.suspend(() =>
      call('health', [], () =>
        Effect.succeed({
          network: 'stellar:testnet',
          latestLedger: ledger,
          relayers: [{ address: FIXTURE_RELAYER, xlmStroops: 10_000_000_000n }],
          treasury: { address: strkey('G', 1, 'TREASURY'), usdcStroops: 1_000_000_000n, xlmStroops: 100_000_000n },
          rentFactor: 47,
          contracts: [
            {
              name: 'spending_limit_policy',
              id: 'CFIXTUREPOLICY',
              liveUntilLedger: ledger + 100_000,
              ledgersLeft: 100_000,
            },
          ],
        }),
      ),
    ),
  }

  return {
    chain,
    calls: () => [...log],
    callsOf: method => log.filter(entry => entry.method === method),
    rules: () => rules.map(rule => ({ ...rule })),
    balanceOf: balance,
    failNext: (method, kind) => {
      failures.set(method, kind)
    },
  }
}

/** The fixture as the `Chain` service (`CHAIN=fixture`). One ledger per layer build. */
export const FixtureChainLayer = (options: FixtureOptions = {}) =>
  Layer.sync(Chain, () => makeFixtureChain(options).chain)
