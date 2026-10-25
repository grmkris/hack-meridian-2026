import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect'

import {
  type AccountPlan,
  Chain,
  ChainError,
  type ChainHealth,
  type ClaimSenderAuth,
  type DepositAddress,
  type OwnerPasskey,
  type PreparedClaim,
  type PreparedOwnerAuth,
  type Receipt,
  type WebAuthnAssertion,
} from '@hm/protocol'
import {
  Account,
  Address,
  Asset,
  authorizeEntry,
  FeeBumpTransaction,
  Keypair,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'

import {
  authorizeWithEd25519,
  authorizeWithWebAuthn,
  ChallengeMismatch,
  entryAddress,
  entryRootCall,
  webAuthnChallenge,
  webAuthnSignerScVal,
} from './auth.ts'
import { fromHex, toBase64Url, toBuffer, toHex } from './bytes.ts'
import { ChainConfig } from './config.ts'
import { INCLUSION_FEE } from './constants.ts'
import {
  contractIdFor,
  createDepositOps,
  EXPIRATION_MARGIN_LEDGERS,
  lockDepositOps,
  registerFunc,
  sweepFunc,
  teardownTx,
} from './deposit.ts'
import { contractCodes, messageOf } from './errors.ts'
import { grantRuleName, grantWindow, ruleLive, SpendingLimitData, spentAt } from './grant.ts'
import { makeInvoker } from './invoke.ts'
import type { NetworkParams } from './network.ts'
import { StellarOps, type StellarOpsShape, type TtlEntry, type TtlStatus } from './ops.ts'
import {
  accountKey,
  accountOf,
  contractCodeKey,
  contractInstanceKey,
  isContractAddress,
  readinessFrom,
  usdcAsset,
  usdcTrustlineKey,
} from './readiness.ts'
import { makeRelayerPool } from './relayers.ts'
import { decodeRentConfig, rentConfigKeys, rentFactor } from './rent.ts'
import {
  addr,
  callContractRule,
  externalSigner,
  i128,
  invokeContractFunc,
  mapEntry,
  option,
  spendingLimitParams,
  str,
  u32,
} from './scval.ts'
import { isRetryableRejection, makeSoroban, nativeOf, signWith, type TxOutcome } from './soroban.ts'
import { deriveVaultKey, makeVaultCore } from './vault.ts'
import { facilitatorBearer, payX402, payX402Mcp, probeFacilitator, x402TargetOf } from './x402.ts'

/** Ledgers a delegated (connection-key) auth entry stays valid: it is signed and submitted in one go. */
const DELEGATED_AUTH_LEDGERS = 60

/** The opaque `payload` of a PreparedOwnerAuth / PreparedClaim (JSON, written and read only here). */
const OwnerPayload = Schema.Struct({
  v: Schema.Literal(1),
  func: Schema.String,
  /** The owner's rule-0 `Signer` ScVal (base64 XDR), read from the account at prepare time. */
  signer: Schema.String,
  ruleIds: Schema.Array(Schema.Finite),
  grantValidUntilLedger: Schema.optional(Schema.Finite),
})
const decodeOwnerPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(OwnerPayload))

const ClaimPayload = Schema.Struct({
  v: Schema.Literal(1),
  func: Schema.String,
  /** The sender's rule-0 signer when the sender is a smart account. */
  signer: Schema.optional(Schema.String),
})
const decodeClaimPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaimPayload))

/** The router's `deposit(g)` view, as `scValToNative` reads it (`None` → null). */
const DepositRecord = Schema.NullOr(Schema.Struct({ recipient: Schema.String, expiration_ledger: Schema.Finite }))
const decodeDepositRecord = Schema.decodeUnknownEffect(DepositRecord)

/** The router's `NothingToSweep` (contracts/deposit): no balance, no trustline, or no allowance left. */
const NOTHING_TO_SWEEP = 4

const badInput = (message: string) => new ChainError({ kind: 'unknown', message })

const fromXdr = <A>(label: string, f: () => A) =>
  Effect.try({ try: f, catch: e => badInput(`${label}: ${messageOf(e)}`) })

/** Receipt from a confirmed transaction; carries `rentStroops` beside the protocol fields when the meta has it. */
export const receiptOf = (o: TxOutcome): Receipt & { readonly rentStroops?: bigint } => ({
  tx: o.hash,
  ledger: o.ledger,
  feeStroops: o.feeCharged,
  feePayer: o.feeSource,
  explorer: o.explorer,
  ...(o.rentCharged === undefined ? {} : { rentStroops: o.rentCharged }),
})

/** Find the entry a given address must sign. */
const entryFor = (entries: ReadonlyArray<xdr.SorobanAuthorizationEntry>, address: string) =>
  Option.fromNullishOr(entries.find(e => entryAddress(e) === address))

const scMapField = (v: xdr.ScVal, name: string): xdr.ScVal | undefined =>
  v.switch().name === 'scvMap'
    ? (v.map() ?? []).find(e => e.key().switch().name === 'scvSymbol' && e.key().sym().toString() === name)?.val()
    : undefined

const isWebAuthnSigner = (s: xdr.ScVal, verifier: string): boolean => {
  const parts = s.vec() ?? []
  return parts[1] !== undefined && Address.fromScVal(parts[1]).toString() === verifier
}

const transferFunc = (usdcSac: string, from: string, to: string, amount: bigint) =>
  invokeContractFunc(usdcSac, 'transfer', [addr(from), addr(to), i128(amount)])

/** The recipient's signed entry must be exactly the prepared `trust(recipient)` (same nonce and invocation). */
const checkRecipientEntry = (prepared: PreparedClaim, signedXdr: string, usdcSac: string) =>
  Effect.gen(function* () {
    const unsigned = yield* fromXdr('recipientEntryXdr', () =>
      xdr.SorobanAuthorizationEntry.fromXDR(prepared.recipientEntryXdr, 'base64'),
    )
    const signed = yield* fromXdr('recipientSignedEntryXdr', () =>
      xdr.SorobanAuthorizationEntry.fromXDR(signedXdr, 'base64'),
    )
    const root = entryRootCall(signed)
    const same =
      entryAddress(signed) === prepared.recipient &&
      root?.contract === usdcSac &&
      root.fn === 'trust' &&
      toBase64Url(signed.rootInvocation().toXDR()) === toBase64Url(unsigned.rootInvocation().toXDR()) &&
      signed.credentials().address().nonce().toString() === unsigned.credentials().address().nonce().toString()
    if (!same) return yield* badInput('the signed recipient entry is not the prepared trust authorization')
    return signed
  })

const findEntry = <E extends { readonly key: xdr.LedgerKey }>(entries: ReadonlyArray<E>, key: xdr.LedgerKey) => {
  const wanted = key.toXDR('base64')
  return entries.find(e => e.key.toXDR('base64') === wanted)
}

/** The WASM hash behind a contract instance entry, if it runs WASM (SACs do not). */
const wasmHashOf = (val: xdr.LedgerEntryData): string | undefined => {
  const exec = val.contractData().val().instance().executable()
  return exec.switch().name === 'contractExecutableWasm' ? toHex(new Uint8Array(exec.wasmHash())) : undefined
}

const capped = (what: string, amount: bigint, cap: bigint) =>
  amount <= cap
    ? Effect.void
    : Effect.fail(
        new ChainError({
          kind: 'declined',
          message: `cap_exceeded: ${what} ${amount} stroops is above the cap ${cap}`,
        }),
      )

export const makeStellar = Effect.gen(function* () {
  const config = yield* ChainConfig
  const net: NetworkParams = config.network
  const C = net.contracts
  const passphrase = net.passphrase
  const soroban = makeSoroban(net)
  const pool = yield* makeRelayerPool(config.relayerSecrets)
  const invoker = makeInvoker(soroban, pool, config.maxFeeStroops)
  const vault = makeVaultCore(yield* deriveVaultKey(config.vaultKey))
  const treasury = Option.map(config.treasurySecret, s => Keypair.fromSecret(Redacted.value(s)))
  const demoRecipient = Option.map(config.demoRecipientSecret, s => Keypair.fromSecret(Redacted.value(s)))
  const viewSource = pool.primary.publicKey()
  const caps = config.caps

  /** The kill switch: nothing that moves value or grants spend authority is signed while payments are disabled. */
  const enabled = (what: string) =>
    caps.paymentsEnabled
      ? Effect.void
      : Effect.fail(
          new ChainError({ kind: 'declined', message: `payments_disabled: ${what} refused (PAYMENTS_ENABLED=false)` }),
        )

  const view = (contract: string, fn: string, args: ReadonlyArray<xdr.ScVal>) =>
    soroban.view(viewSource, invokeContractFunc(contract, fn, args))

  const latest = soroban.latestLedger

  /** Rule 0's WebAuthn signer (the passkey), as stored: what the approval's AuthPayload must name. */
  const ownerSigner = (contractId: string) =>
    Effect.gen(function* () {
      const rule = yield* view(contractId, 'get_context_rule', [u32(0)])
      const signers = scMapField(rule, 'signers')?.vec() ?? []
      const signer = signers.find(x => isWebAuthnSigner(x, C.webauthnVerifier)) ?? signers[0]
      if (signer === undefined) return yield* badInput(`account ${contractId} has no rule-0 signer`)
      return signer
    })

  const prepareOwner = (
    kind: PreparedOwnerAuth['kind'],
    contractId: string,
    func: xdr.HostFunction,
    validForLedgers: number,
    extra: { readonly grantValidUntilLedger?: number } = {},
  ) =>
    Effect.gen(function* () {
      const signer = yield* ownerSigner(contractId)
      const prep = yield* invoker.prepare(func)
      const entry = yield* Effect.fromOption(entryFor(prep.entries, contractId), () =>
        badInput(`simulation asked no authorization from ${contractId}`),
      )
      const validUntilLedger = prep.latestLedger + validForLedgers
      const { challenge } = webAuthnChallenge(entry, [0], validUntilLedger, passphrase)
      const payload = {
        v: 1 as const,
        func: func.toXDR('base64'),
        signer: signer.toXDR('base64'),
        ruleIds: [0],
        ...extra,
      }
      return {
        kind,
        contractId,
        challenge,
        validUntilLedger,
        entryXdr: entry.toXDR('base64'),
        payload: JSON.stringify(payload),
      } satisfies PreparedOwnerAuth
    })

  const passkeySign = (
    entry: xdr.SorobanAuthorizationEntry,
    assertion: WebAuthnAssertion,
    signerXdr: string,
    ruleIds: ReadonlyArray<number>,
    validUntilLedger: number,
  ) =>
    Effect.tryPromise({
      try: () =>
        authorizeWithWebAuthn(entry, assertion, {
          signerScVal: xdr.ScVal.fromXDR(signerXdr, 'base64'),
          ruleIds,
          validUntilLedger,
          networkPassphrase: passphrase,
        }),
      catch: e =>
        Schema.is(ChallengeMismatch)(e)
          ? new ChainError({ kind: 'simulation_failed', message: 'the passkey signed a different challenge' })
          : badInput(`passkey assertion: ${messageOf(e)}`),
    })

  const finalizeOwner = (prepared: PreparedOwnerAuth, assertion: WebAuthnAssertion, kind: PreparedOwnerAuth['kind']) =>
    Effect.gen(function* () {
      if (prepared.kind !== kind) return yield* badInput(`expected a ${kind} preparation, got ${prepared.kind}`)
      const p = yield* decodeOwnerPayload(prepared.payload).pipe(
        Effect.mapError(() => badInput('bad prepared payload')),
      )
      const entry = yield* fromXdr('entryXdr', () => xdr.SorobanAuthorizationEntry.fromXDR(prepared.entryXdr, 'base64'))
      const func = yield* fromXdr('func', () => xdr.HostFunction.fromXDR(p.func, 'base64'))
      const signed = yield* passkeySign(entry, assertion, p.signer, p.ruleIds, prepared.validUntilLedger)
      return { outcome: yield* invoker.submit(func, [signed]), payload: p }
    })

  /** Sign every entry for `address` with a classic keypair (G-address credentials), keep the others. */
  const signClassic = (entries: ReadonlyArray<xdr.SorobanAuthorizationEntry>, kp: Keypair, validUntilLedger: number) =>
    Effect.forEach(entries, e =>
      entryAddress(e) === kp.publicKey()
        ? Effect.tryPromise({
            try: () => authorizeEntry(e, kp, validUntilLedger, passphrase),
            catch: err => badInput(`sign entry: ${messageOf(err)}`),
          })
        : Effect.succeed(e),
    )

  /** A SAC transfer from a classic G account that authorizes by signature; a relayer is source and pays. */
  const classicTransfer = (from: Keypair, to: string, amount: bigint) =>
    Effect.gen(function* () {
      const func = transferFunc(C.usdcSac, from.publicKey(), to, amount)
      const prep = yield* invoker.prepare(func)
      const signed = yield* signClassic(prep.entries, from, prep.latestLedger + DELEGATED_AUTH_LEDGERS)
      return yield* invoker.submit(func, signed)
    })

  const ledgerEntries = (keys: ReadonlyArray<xdr.LedgerKey>) =>
    soroban.read('getLedgerEntries', s => s.getLedgerEntries(...keys)).pipe(Effect.map(r => r.entries))

  /** XLM and USDC of a classic account (0 when it or its trustline is missing). */
  const classicBalances = (account: string) =>
    Effect.gen(function* () {
      const entries = yield* ledgerEntries([accountKey(account), usdcTrustlineKey(account, net.usdcIssuer)])
      let xlm = 0n
      let usdc = 0n
      for (const e of entries) {
        const kind = e.val.switch().name
        if (kind === 'account') xlm = BigInt(e.val.account().balance().toString())
        if (kind === 'trustline') usdc = BigInt(e.val.trustLine().balance().toString())
      }
      return {
        xlm,
        usdc,
        accountExists: entries.some(e => e.val.switch().name === 'account'),
        trustline: entries.some(e => e.val.switch().name === 'trustline'),
      }
    })

  const sacBalance = (contractId: string, asset: Asset) =>
    soroban
      .read('getSACBalance', s => s.getSACBalance(contractId, asset, passphrase))
      .pipe(Effect.map(r => BigInt(r.balanceEntry?.amount ?? '0')))

  const balances = (address: string) =>
    Effect.gen(function* () {
      const account = accountOf(address)
      if (account !== undefined) {
        const b = yield* classicBalances(account)
        return { usdc: b.usdc, xlm: b.xlm }
      }
      if (!isContractAddress(address)) return yield* badInput(`not a Stellar address: ${address}`)
      const [usdc, xlm] = yield* Effect.all(
        [sacBalance(address, usdcAsset(net.usdcIssuer)), sacBalance(address, Asset.native())],
        {
          concurrency: 2,
        },
      )
      return { usdc, xlm }
    })

  const readiness = (address: string) =>
    Effect.gen(function* () {
      const account = accountOf(address)
      if (account !== undefined) {
        const b = yield* classicBalances(account)
        return readinessFrom('account', { account: b.accountExists, trustline: b.trustline, contract: false })
      }
      if (!isContractAddress(address)) return yield* badInput(`not a Stellar address: ${address}`)
      const entries = yield* ledgerEntries([contractInstanceKey(address)])
      return readinessFrom('contract', { account: false, trustline: false, contract: entries.length > 0 })
    })

  const deployAccount = (owner: OwnerPasskey) =>
    Effect.gen(function* () {
      const signer = webAuthnSignerScVal(owner.pubkey, owner.credentialId, C.webauthnVerifier)
      const { outcome, sim } = yield* invoker.submitSourceAuthorized(relayer =>
        Operation.createCustomContract({
          address: new Address(relayer.publicKey()),
          wasmHash: toBuffer(fromHex(C.accountWasmHash)),
          salt: toBuffer(crypto.getRandomValues(new Uint8Array(32))),
          constructorArgs: [xdr.ScVal.scvVec([signer]), xdr.ScVal.scvMap([])],
        }),
      )
      const retval = sim.result?.retval
      const contractId = retval === undefined ? undefined : Address.fromScVal(retval).toString()
      if (contractId === undefined) return yield* badInput('deploy simulation returned no contract id')
      if (config.walletTtlLedgers > 0)
        yield* invoker.extendTtl([contractInstanceKey(contractId)], config.walletTtlLedgers).pipe(
          Effect.tapError(e => Effect.logWarning(`wallet ${contractId}: TTL extension failed: ${e.message}`)),
          Effect.ignore,
        )
      return { contractId, tx: outcome.hash }
    })

  /**
   * Deposit-first: the primary relayer is the deployer, so the id is fixed before anything is onchain. The plan stores
   * the deployer, so a later change of relayers cannot move a planned wallet.
   */
  const planAccount = Effect.sync((): AccountPlan => {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const deployer = pool.primary.publicKey()
    return { contractId: contractIdFor(deployer, salt, passphrase), deployer, salt: toHex(salt) }
  })

  /** One source-authorized operation from a given relayer (the deployer must be the source), retried on txBadSeq. */
  const submitAsRelayer = (relayer: Keypair, op: xdr.Operation) =>
    Effect.gen(function* () {
      const source = relayer.publicKey()
      const raw = new TransactionBuilder(new Account(source, yield* soroban.sequence(source)), {
        fee: String(INCLUSION_FEE),
        networkPassphrase: passphrase,
      })
        .addOperation(op)
        .setTimeout(120)
        .build()
      const sim = yield* soroban.simulate(raw, 'record', 'simulation')
      const tx = rpc.assembleTransaction(raw, sim).build()
      if (BigInt(tx.fee) > config.maxFeeStroops)
        return yield* new ChainError({
          kind: 'fee_ceiling_exceeded',
          message: `the deploy needs ${tx.fee} stroops, the ceiling is ${config.maxFeeStroops}; not submitted`,
        })
      return yield* soroban.sendAndPoll(signWith(tx, relayer))
    }).pipe(Effect.retry({ times: 3, while: isRetryableRejection }))

  const deployPlannedAccount = (owner: OwnerPasskey, plan: AccountPlan) =>
    Effect.gen(function* () {
      const salt = fromHex(plan.salt)
      if (salt.length !== 32) return yield* badInput('the plan salt is not 32 bytes')
      if (contractIdFor(plan.deployer, salt, passphrase) !== plan.contractId)
        return yield* badInput(`the plan does not yield ${plan.contractId}`)
      const deployer = pool.keypairs.find(kp => kp.publicKey() === plan.deployer)
      if (deployer === undefined)
        return yield* badInput(`deployer ${plan.deployer} is not one of this stage's relayers`)
      if ((yield* ledgerEntries([contractInstanceKey(plan.contractId)])).length > 0)
        return { contractId: plan.contractId, tx: null }
      const signer = webAuthnSignerScVal(owner.pubkey, owner.credentialId, C.webauthnVerifier)
      const outcome = yield* submitAsRelayer(
        deployer,
        Operation.createCustomContract({
          address: new Address(plan.deployer),
          wasmHash: toBuffer(fromHex(C.accountWasmHash)),
          salt: toBuffer(salt),
          constructorArgs: [xdr.ScVal.scvVec([signer]), xdr.ScVal.scvMap([])],
        }),
      )
      const returned = outcome.returnValue === undefined ? undefined : Address.fromScVal(outcome.returnValue).toString()
      if (returned !== plan.contractId)
        return yield* new ChainError({
          kind: 'unknown',
          message: `the deploy returned ${returned ?? 'nothing'}, not the planned ${plan.contractId}`,
          tx: outcome.hash,
        })
      if (config.walletTtlLedgers > 0)
        yield* invoker.extendTtl([contractInstanceKey(plan.contractId)], config.walletTtlLedgers).pipe(
          Effect.tapError(e => Effect.logWarning(`wallet ${plan.contractId}: TTL extension failed: ${e.message}`)),
          Effect.ignore,
        )
      return { contractId: plan.contractId, tx: outcome.hash }
    })

  const fundNewWallet = (contractId: string, usdc: bigint) =>
    Effect.gen(function* () {
      yield* enabled('treasury funding')
      const kp = yield* Effect.fromOption(treasury, () => badInput('TREASURY_SECRET is not configured'))
      const outcome = yield* classicTransfer(kp, contractId, usdc)
      return { tx: outcome.hash }
    })

  const newSigner = vault.generate

  const prepareInstallGrant = (
    contractId: string,
    signerPub: Uint8Array,
    limitStroops: bigint,
    lifetimeSeconds: number,
  ) =>
    Effect.gen(function* () {
      if (signerPub.length !== 32) return yield* badInput('signerPub must be a 32-byte Ed25519 public key')
      if (limitStroops <= 0n) return yield* badInput('limit must be positive')
      yield* capped('grant', limitStroops, caps.maxGrantStroops)
      const window = yield* Effect.try({
        try: () => grantWindow(lifetimeSeconds, 0),
        catch: e => badInput(messageOf(e)),
      })
      const now = yield* latest
      const validUntil = now + window.lifetimeLedgers
      const policies = xdr.ScVal.scvMap([
        mapEntry(addr(C.spendingLimitPolicy), spendingLimitParams(limitStroops, window.periodLedgers)),
      ])
      const func = invokeContractFunc(contractId, 'add_context_rule', [
        callContractRule(C.usdcSac),
        str(grantRuleName(toHex(signerPub))),
        option(u32(validUntil)),
        xdr.ScVal.scvVec([externalSigner(C.ed25519Verifier, signerPub)]),
        policies,
      ])
      return yield* prepareOwner('install_grant', contractId, func, config.ownerAuthLedgers, {
        grantValidUntilLedger: validUntil,
      })
    })

  const installGrant = (prepared: PreparedOwnerAuth, assertion: WebAuthnAssertion) =>
    Effect.gen(function* () {
      yield* enabled('grant install')
      const { outcome, payload } = yield* finalizeOwner(prepared, assertion, 'install_grant')
      const id = outcome.returnValue === undefined ? undefined : scMapField(outcome.returnValue, 'id')
      if (id === undefined || id.switch().name !== 'scvU32')
        return yield* new ChainError({
          kind: 'unknown',
          message: 'add_context_rule returned no rule id',
          tx: outcome.hash,
        })
      return { ruleId: id.u32(), validUntilLedger: payload.grantValidUntilLedger ?? 0, tx: outcome.hash }
    })

  const prepareRemoveGrant = (contractId: string, ruleId: number) =>
    prepareOwner(
      'remove_grant',
      contractId,
      invokeContractFunc(contractId, 'remove_context_rule', [u32(ruleId)]),
      config.ownerAuthLedgers,
    )

  const removeGrant = (prepared: PreparedOwnerAuth, assertion: WebAuthnAssertion) =>
    finalizeOwner(prepared, assertion, 'remove_grant').pipe(Effect.map(({ outcome }) => ({ tx: outcome.hash })))

  const readGrant = (contractId: string, ruleId: number) =>
    Effect.gen(function* () {
      const now = yield* latest
      const rule = yield* view(contractId, 'get_context_rule', [u32(ruleId)]).pipe(Effect.option)
      if (Option.isNone(rule)) return { spent: 0n, limit: 0n, validUntilLedger: 0, live: false }
      const until = scMapField(rule.value, 'valid_until')
      const validUntil = until === undefined || until.switch().name !== 'scvU32' ? null : until.u32()
      const raw = yield* view(C.spendingLimitPolicy, 'get_spending_limit_data', [u32(ruleId), addr(contractId)])
      const data = yield* Schema.decodeUnknownEffect(SpendingLimitData)(nativeOf(raw)).pipe(
        Effect.mapError(e => badInput(`spending limit data: ${messageOf(e)}`)),
      )
      return {
        spent: spentAt(data, now),
        limit: data.spending_limit,
        validUntilLedger: validUntil ?? 0,
        live: ruleLive(validUntil, now),
      }
    })

  const prepareOwnerTransfer = (contractId: string, to: string, amountStroops: bigint, validForLedgers: number) =>
    capped('owner payment', amountStroops, caps.maxOwnerPaymentStroops).pipe(
      Effect.andThen(
        prepareOwner(
          'owner_transfer',
          contractId,
          transferFunc(C.usdcSac, contractId, to, amountStroops),
          validForLedgers,
        ),
      ),
    )

  const finalizeOwnerTransfer = (prepared: PreparedOwnerAuth, assertion: WebAuthnAssertion) =>
    enabled('owner payment').pipe(
      Effect.andThen(finalizeOwner(prepared, assertion, 'owner_transfer')),
      Effect.map(({ outcome }) => receiptOf(outcome)),
    )

  /** K signs the account's entry under its rule; a relayer submits. Over-limit fails at the enforce simulation. */
  const delegatedTransfer = (
    contractId: string,
    ruleId: number,
    signerKeyRef: string,
    to: string,
    amountStroops: bigint,
    maxFeeStroops?: bigint,
  ) =>
    Effect.gen(function* () {
      yield* enabled('delegated payment')
      const k = yield* vault.unseal(signerKeyRef)
      const func = transferFunc(C.usdcSac, contractId, to, amountStroops)
      const prep = yield* invoker.prepare(func)
      const signed = yield* Effect.forEach(prep.entries, e =>
        entryAddress(e) === contractId
          ? Effect.tryPromise({
              try: () =>
                authorizeWithEd25519(
                  e,
                  k,
                  [ruleId],
                  prep.latestLedger + DELEGATED_AUTH_LEDGERS,
                  passphrase,
                  C.ed25519Verifier,
                ),
              catch: err => badInput(`sign entry: ${messageOf(err)}`),
            })
          : Effect.succeed(e),
      )
      return receiptOf(yield* invoker.submit(func, signed, maxFeeStroops))
    })

  const createPocket = (signerKeyRef: string) =>
    Effect.gen(function* () {
      const k = yield* vault.unseal(signerKeyRef)
      const address = k.publicKey()
      const now = yield* classicBalances(address)
      if (now.accountExists && now.trustline) return { address, tx: '' }
      const outcome = yield* invoker.submitClassic(
        relayer => [
          Operation.beginSponsoringFutureReserves({ sponsoredId: address, source: relayer.publicKey() }),
          ...(now.accountExists ? [] : [Operation.createAccount({ destination: address, startingBalance: '0' })]),
          Operation.changeTrust({ asset: usdcAsset(net.usdcIssuer), source: address }),
          Operation.endSponsoringFutureReserves({ source: address }),
        ],
        [k],
      )
      return { address, tx: outcome.hash }
    })

  /** Revoke or expiry: G(K)'s whole USDC float back to the smart account (SAC transfer, K signs, relayer pays). */
  const sweepPocket = (signerKeyRef: string, toContractId: string) =>
    Effect.gen(function* () {
      const k = yield* vault.unseal(signerKeyRef)
      const now = yield* classicBalances(k.publicKey())
      if (now.usdc <= 0n)
        return yield* new ChainError({ kind: 'insufficient_balance', message: `pocket ${k.publicKey()} holds no USDC` })
      return receiptOf(yield* classicTransfer(k, toContractId, now.usdc))
    })

  /** After a sweep: drop the trustline and merge G(K) into a relayer; the sponsored reserves return. */
  const closePocket = (signerKeyRef: string) =>
    Effect.gen(function* () {
      const k = yield* vault.unseal(signerKeyRef)
      const address = k.publicKey()
      const now = yield* classicBalances(address)
      if (!now.accountExists) return yield* badInput(`pocket ${address} does not exist`)
      if (now.usdc > 0n)
        return yield* badInput(`pocket ${address} still holds ${now.usdc} stroops of USDC; sweep first`)
      const outcome = yield* invoker.submitClassic(
        relayer => [
          ...(now.trustline
            ? [Operation.changeTrust({ asset: usdcAsset(net.usdcIssuer), limit: '0', source: address })]
            : []),
          Operation.accountMerge({ destination: relayer.publicKey(), source: address }),
        ],
        [k],
      )
      return receiptOf(outcome)
    })

  const depositRouter =
    C.depositRouter === ''
      ? Effect.fail(
          new ChainError({ kind: 'declined', message: `deposit_unavailable: no deposit router on ${net.name}` }),
        )
      : Effect.succeed(C.depositRouter)

  /**
   * docs/spikes/s8-deposit.md: create (sponsored G + trustline) → register (G approves the router, G→C bound for
   * good) → lock (master weight 0, the teardown as G's only pre-auth signer). G's key lives only in this closure. A failure after the
   * create leaves a sponsored, empty G nobody can use (its key is gone): 1.5 XLM of the relayer's reserve, no funds.
   */
  const createDepositAddress = (contractId: string) =>
    Effect.gen(function* () {
      if (!isContractAddress(contractId)) return yield* badInput(`not a smart account: ${contractId}`)
      const router = yield* depositRouter
      const g = Keypair.random()
      const address = g.publicKey()
      const usdc = usdcAsset(net.usdcIssuer)
      let sponsor = pool.primary.publicKey()
      const created = yield* invoker.submitClassic(
        relayer => {
          sponsor = relayer.publicKey()
          return createDepositOps(sponsor, address, usdc)
        },
        [g],
      )
      const max = yield* view(router, 'max_expiration_ledger', [])
      if (max.switch().name !== 'scvU32') return yield* badInput('max_expiration_ledger returned no ledger')
      const func = registerFunc(router, address, contractId, max.u32() - EXPIRATION_MARGIN_LEDGERS)
      const prep = yield* invoker.prepare(func)
      const signed = yield* signClassic(prep.entries, g, prep.latestLedger + DELEGATED_AUTH_LEDGERS)
      const registered = yield* invoker.submit(func, signed)
      const until = registered.returnValue
      if (until === undefined || until.switch().name !== 'scvU32')
        return yield* new ChainError({ kind: 'unknown', message: 'register returned no ledger', tx: registered.hash })
      const teardown = teardownTx(address, yield* soroban.sequence(address), sponsor, usdc, passphrase)
      const locked = yield* invoker.submitClassic(
        relayer => lockDepositOps(relayer.publicKey(), address, teardown.hash),
        [g],
      )
      return {
        address,
        recipient: contractId,
        expirationLedger: until.u32(),
        registeredLedger: registered.ledger,
        txs: { create: created.hash, register: registered.hash, lock: locked.hash },
        teardownXdr: teardown.xdr,
      } satisfies DepositAddress
    })

  /**
   * Anyone may sweep; the relayer submits with no authorization entries. Refuses a G the router binds elsewhere.
   * Null, with nothing submitted, when G holds no USDC or the router may take none of it (allowance expired).
   */
  const sweepDeposit = (depositAddress: string, contractId: string) =>
    Effect.gen(function* () {
      const router = yield* depositRouter
      if (accountOf(depositAddress) !== depositAddress) return yield* badInput(`not a G… address: ${depositAddress}`)
      // The balance first: an idle address (the watcher's usual case) costs one ledger read and no simulation.
      const held = yield* classicBalances(depositAddress)
      if (held.usdc <= 0n) return null
      const raw = yield* view(router, 'deposit', [addr(depositAddress)])
      const bound = yield* decodeDepositRecord(nativeOf(raw) ?? null).pipe(
        Effect.mapError(e => badInput(`deposit record: ${messageOf(e)}`)),
      )
      if (bound === null)
        return yield* new ChainError({
          kind: 'declined',
          message: `deposit_unknown: ${depositAddress} is not registered`,
        })
      if (bound.recipient !== contractId)
        return yield* new ChainError({
          kind: 'declined',
          message: `deposit_mismatch: ${depositAddress} pays ${bound.recipient}, not ${contractId}`,
        })
      const outcome = yield* invoker.submit(sweepFunc(router, depositAddress), []).pipe(
        Effect.catchIf(
          e => contractCodes(e.message).includes(NOTHING_TO_SWEEP),
          () => Effect.succeed(null),
        ),
      )
      if (outcome === null) return null
      const swept = outcome.returnValue === undefined ? held.usdc : BigInt(String(nativeOf(outcome.returnValue)))
      return { amountStroops: swept, receipt: receiptOf(outcome) }
    })

  const closeDeposit = (depositAddress: string, teardownXdr: string) =>
    Effect.gen(function* () {
      const inner = yield* fromXdr('teardownXdr', () => TransactionBuilder.fromXDR(teardownXdr, passphrase))
      if (inner instanceof FeeBumpTransaction || inner.source !== depositAddress)
        return yield* badInput(`not the teardown of ${depositAddress}`)
      const now = yield* classicBalances(depositAddress)
      if (!now.accountExists) return yield* badInput(`deposit address ${depositAddress} does not exist`)
      if (now.usdc > 0n)
        return yield* badInput(`deposit address ${depositAddress} still holds ${now.usdc} stroops of USDC; sweep first`)
      const outcome = yield* pool.run(relayer => {
        const bump = TransactionBuilder.buildFeeBumpTransaction(relayer, String(INCLUSION_FEE), inner, passphrase)
        bump.sign(relayer)
        return soroban.sendAndPoll(bump)
      })
      return receiptOf(outcome)
    })

  const ttlStatus = (contractIds: ReadonlyArray<string>, wasmHashes: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const now = yield* latest
      const nowMs = yield* Clock.currentTimeMillis
      const expiresAt = (until: number | undefined) =>
        until === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(nowMs + (until - now) * 5000))
      const ids = yield* Effect.forEach(contractIds, id =>
        isContractAddress(id) ? Effect.succeed(id) : Effect.fail(badInput(`not a contract id: ${id}`)),
      )
      const instanceEntries = ids.length === 0 ? [] : yield* ledgerEntries(ids.map(contractInstanceKey))
      const out: Array<TtlEntry> = []
      const codeHashes = new Set(wasmHashes)
      for (const id of ids) {
        const entry = findEntry(instanceEntries, contractInstanceKey(id))
        out.push({
          target: id,
          kind: 'instance',
          liveUntilLedger: entry?.liveUntilLedgerSeq ?? null,
          expiresAtApprox: expiresAt(entry?.liveUntilLedgerSeq),
        })
        const hash = entry === undefined ? undefined : wasmHashOf(entry.val)
        if (hash !== undefined) codeHashes.add(hash)
      }
      const hashes = [...codeHashes]
      const codeEntries = hashes.length === 0 ? [] : yield* ledgerEntries(hashes.map(contractCodeKey))
      for (const h of hashes) {
        const entry = findEntry(codeEntries, contractCodeKey(h))
        out.push({
          target: h,
          kind: 'code',
          liveUntilLedger: entry?.liveUntilLedgerSeq ?? null,
          expiresAtApprox: expiresAt(entry?.liveUntilLedgerSeq),
        })
      }
      return { latestLedger: now, entries: out } satisfies TtlStatus
    })

  const extendTtl = (target: string, ledgers: number, maxFeeStroops?: bigint) =>
    Effect.gen(function* () {
      const key = isContractAddress(target)
        ? contractInstanceKey(target)
        : /^[0-9a-f]{64}$/u.test(target)
          ? contractCodeKey(target)
          : yield* badInput(`not a contract id or WASM hash: ${target}`)
      return receiptOf(yield* invoker.extendTtl([key], ledgers, maxFeeStroops))
    })

  const readRentFactor = ledgerEntries(rentConfigKeys()).pipe(
    Effect.map(entries => {
      const rent = decodeRentConfig(entries.map(e => e.val))
      return rent === undefined ? null : rentFactor(rent)
    }),
  )

  /** The x402 price cap is the smaller of the caller's and MAX_X402_PRICE_USDC. */
  const x402Cap = (max: bigint) => (max < caps.maxX402PriceStroops ? max : caps.maxX402PriceStroops)

  const x402Deps = { soroban, target: x402TargetOf(net), rpcUrl: net.rpcUrl, fetch: config.fetch, receipt: receiptOf }

  const prepareClaim = (sender: string, recipient: string, amountStroops: bigint, validForLedgers: number) =>
    Effect.gen(function* () {
      if (accountOf(recipient) === undefined) return yield* badInput('a claim recipient must be a G… account')
      yield* capped('claim payment', amountStroops, caps.maxOwnerPaymentStroops)
      const func = invokeContractFunc(C.onboardRouter, 'pay_and_trust', [
        addr(sender),
        addr(recipient),
        addr(C.usdcSac),
        i128(amountStroops),
      ])
      const signer = isContractAddress(sender) ? Option.some(yield* ownerSigner(sender)) : Option.none()
      const prep = yield* invoker.prepare(func, 'record_allow_nonroot')
      const senderEntry = yield* Effect.fromOption(entryFor(prep.entries, sender), () =>
        badInput('simulation asked no authorization from the sender'),
      )
      const recipientEntry = Option.getOrUndefined(entryFor(prep.entries, recipient))
      const validUntilLedger = prep.latestLedger + validForLedgers
      const payload = {
        v: 1 as const,
        func: func.toXDR('base64'),
        ...(Option.isSome(signer) ? { signer: signer.value.toXDR('base64') } : {}),
      }
      return {
        sender,
        recipient,
        amountStroops,
        validUntilLedger,
        recipientEntryXdr: recipientEntry?.toXDR('base64') ?? '',
        senderEntryXdr: senderEntry.toXDR('base64'),
        senderChallenge: webAuthnChallenge(senderEntry, [0], validUntilLedger, passphrase).challenge,
        payload: JSON.stringify(payload),
      } satisfies PreparedClaim
    })

  const signClaimAsDemoRecipient = (prepared: PreparedClaim) =>
    Effect.gen(function* () {
      const kp = yield* Effect.fromOption(demoRecipient, () => badInput('DEMO_RECIPIENT_SECRET is not configured'))
      if (kp.publicKey() !== prepared.recipient) return yield* badInput("the demo key is not this claim's recipient")
      if (prepared.recipientEntryXdr === '') return ''
      const entry = yield* fromXdr('recipientEntryXdr', () =>
        xdr.SorobanAuthorizationEntry.fromXDR(prepared.recipientEntryXdr, 'base64'),
      )
      const signed = yield* Effect.tryPromise({
        try: () => authorizeEntry(entry, kp, prepared.validUntilLedger, passphrase),
        catch: e => badInput(`sign recipient entry: ${messageOf(e)}`),
      })
      return signed.toXDR('base64')
    })

  const finalizeClaim = (prepared: PreparedClaim, recipientSignedEntryXdr: string, sender: ClaimSenderAuth) =>
    Effect.gen(function* () {
      yield* enabled('claim payment')
      const p = yield* decodeClaimPayload(prepared.payload).pipe(
        Effect.mapError(() => badInput('bad prepared payload')),
      )
      const func = yield* fromXdr('func', () => xdr.HostFunction.fromXDR(p.func, 'base64'))
      const senderEntry = yield* fromXdr('senderEntryXdr', () =>
        xdr.SorobanAuthorizationEntry.fromXDR(prepared.senderEntryXdr, 'base64'),
      )
      const recipientSigned =
        prepared.recipientEntryXdr === ''
          ? []
          : [yield* checkRecipientEntry(prepared, recipientSignedEntryXdr, C.usdcSac)]
      const senderSigned =
        sender._tag === 'Owner'
          ? yield* p.signer === undefined
              ? Effect.fail(badInput('owner approval needs a smart-account sender'))
              : passkeySign(senderEntry, sender.assertion, p.signer, [0], prepared.validUntilLedger)
          : yield* Effect.gen(function* () {
              const k = yield* vault.unseal(sender.signerKeyRef)
              const now = yield* latest
              return yield* Effect.tryPromise({
                try: () =>
                  authorizeWithEd25519(
                    senderEntry,
                    k,
                    [sender.ruleId],
                    now + DELEGATED_AUTH_LEDGERS,
                    passphrase,
                    C.ed25519Verifier,
                  ),
                catch: e => badInput(`sign sender entry: ${messageOf(e)}`),
              })
            })
      return receiptOf(yield* invoker.submit(func, [...recipientSigned, senderSigned]))
    })

  const health = Effect.gen(function* () {
    const latestLedger = yield* latest
    const relayers = yield* Effect.forEach(
      pool.keypairs,
      kp => Effect.map(classicBalances(kp.publicKey()), b => ({ address: kp.publicKey(), xlmStroops: b.xlm })),
      { concurrency: 3 },
    )
    const treasuryHealth = yield* Option.match(treasury, {
      onNone: () => Effect.succeed(null),
      onSome: kp =>
        Effect.map(classicBalances(kp.publicKey()), b => ({
          address: kp.publicKey(),
          usdcStroops: b.usdc,
          xlmStroops: b.xlm,
        })),
    })
    const rent = yield* readRentFactor.pipe(Effect.orElseSucceed(() => null))
    const ozKey = Option.getOrUndefined(Option.map(config.ozApiKey, Redacted.value))
    const keyFor = (url: string) => facilitatorBearer(url, ozKey)
    const facilitators = yield* Effect.all(
      [
        ...(net.facilitatorUrl === ''
          ? []
          : [probeFacilitator(config.fetch, net.facilitatorUrl, net.x402Network, keyFor(net.facilitatorUrl))]),
        ...(net.fallbackFacilitatorUrl === ''
          ? []
          : [
              probeFacilitator(
                config.fetch,
                net.fallbackFacilitatorUrl,
                net.x402Network,
                keyFor(net.fallbackFacilitatorUrl),
              ),
            ]),
      ],
      { concurrency: 2 },
    )
    return {
      network: net.name,
      latestLedger,
      relayers,
      treasury: treasuryHealth,
      rentFactor: rent,
      facilitators,
    } satisfies ChainHealth & { readonly facilitators: ReadonlyArray<unknown> }
  })

  const chain = Chain.of({
    planAccount,
    deployPlannedAccount,
    depositsAvailable: C.depositRouter !== '',
    deployAccount,
    fundNewWallet,
    newSigner,
    prepareInstallGrant,
    installGrant,
    prepareRemoveGrant,
    removeGrant,
    readGrant,
    prepareOwnerTransfer,
    finalizeOwnerTransfer,
    delegatedTransfer,
    createPocket,
    sweepPocket,
    createDepositAddress,
    sweepDeposit,
    payX402: (signerKeyRef, url, maxAmountStroops, paymentId, onQuote) =>
      enabled('x402 payment').pipe(
        Effect.andThen(vault.unseal(signerKeyRef)),
        Effect.flatMap(k => payX402(x402Deps, k, url, x402Cap(maxAmountStroops), paymentId, onQuote)),
      ),
    payX402Mcp: (signerKeyRef, mcpUrl, tool, args, maxAmountStroops, paymentId, onQuote) =>
      enabled('x402 payment').pipe(
        Effect.andThen(vault.unseal(signerKeyRef)),
        Effect.flatMap(k => payX402Mcp(x402Deps, k, mcpUrl, tool, args, x402Cap(maxAmountStroops), paymentId, onQuote)),
      ),
    balances,
    readiness,
    prepareClaim,
    signClaimAsDemoRecipient,
    finalizeClaim,
    health,
  })
  const ops = StellarOps.of({
    closePocket,
    closeDeposit,
    ttlStatus,
    extendTtl,
    rentFactor: readRentFactor,
    network: net,
    caps,
  })
  return { chain, ops } satisfies { chain: Chain['Service']; ops: StellarOpsShape }
})

/** One relayer pool and vault behind both services, so sequence locks are shared. */
export class StellarCore extends Context.Service<
  StellarCore,
  { readonly chain: Chain['Service']; readonly ops: StellarOpsShape }
>()('hm/stellar/StellarCore') {
  static readonly layer: Layer.Layer<StellarCore, ChainError, ChainConfig> = Layer.effect(StellarCore, makeStellar)
}

/** `Chain` and `StellarOps` on Stellar testnet (one shared core). Needs `ChainConfig`. */
export const StellarLive: Layer.Layer<Chain | StellarOps, ChainError, ChainConfig> = Layer.mergeAll(
  Layer.effect(
    Chain,
    Effect.gen(function* () {
      return (yield* StellarCore).chain
    }),
  ),
  Layer.effect(
    StellarOps,
    Effect.gen(function* () {
      return (yield* StellarCore).ops
    }),
  ),
).pipe(Layer.provide(StellarCore.layer))
