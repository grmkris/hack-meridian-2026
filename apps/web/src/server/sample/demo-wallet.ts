import { Effect, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

import {
  Chain,
  type Connection,
  fromStroops,
  PreparedOwnerAuth,
  type SpendingGrant,
  toStroops,
  type Wallet,
} from '@hm/protocol'
import { SoftPasskey } from '@hm/stellar/testing'

import { isoIn, nowIso, nowMillis, randomId } from '../clock.ts'
import { Network } from '../network.ts'
import { checkAssertion, createWallet, registrationOptions } from '../owner.ts'
import type { ConnectionProps } from '../props.ts'
import { revokeConnection } from '../revoke.ts'
import {
  connectionsOfWallet,
  createConnection,
  createContact,
  createPendingGrant,
  createSession,
  pendingGrant,
  replaceDestination,
  saveToolResult,
  searchContacts,
  toolResult,
  walletByCredential,
} from '../store.ts'
import type { ToolContext } from '../tools.ts'
import { type Site, WalletSettings } from '../wallet-settings.ts'
import { ALLOWANCE_LIFETIME_S, SAMPLE_AMOUNTS, SAMPLE_CLIENT, SAMPLE_LIMITS, type SampleLine } from './model.ts'
import { type DemoOwner, passkeyAnswer, removeRule } from './owner-pages.ts'
import { seal, unseal } from './sealed.ts'

/**
 * Nod's own demo wallet for /sample: a smart account like any other (created through `createWallet`, the passkey
 * registration path), whose owner is a software passkey the service holds. The passkey's private key is sealed under
 * VAULT_KEY in D1 (tool_results, scope `sample`); the wallet is found again by its credential id. The sample agent is a
 * connection with a 5 USDC allowance installed through the consent page's steps: K, the rule install signed by the
 * owner's passkey, the pocket, the connection row.
 */

export class SetupError extends Schema.TaggedError<SetupError>()('SetupError', { message: Schema.String }) {}

const RECORD = { scope: 'sample', key: 'demo-owner' } as const
const DemoOwnerRecord = Schema.fromJsonString(Schema.Struct({ sealed: Schema.String }))
export const DEMO_WALLET_NAME = 'Nod demo wallet'

type Say = (line: SampleLine) => Effect.Effect<void>

const setupError = (message: string) => new SetupError({ message })

/** The demo owner's passkey, created on first use and sealed; restored for this stage's origin and RP id. */
export const demoPasskey = (site: Site, secret: string) =>
  Effect.gen(function* () {
    if ((yield* toolResult(RECORD.scope, RECORD.key)) === undefined) {
      const fresh = yield* Effect.promise(() => SoftPasskey.create(site.rpId, site.origin))
      const sealed = yield* seal(secret, yield* Effect.promise(() => fresh.serialize()))
      // INSERT OR IGNORE: if two first runs ever raced, both read back the first one's key below.
      yield* saveToolResult(RECORD.scope, RECORD.key, 'sample_demo_owner', JSON.stringify({ sealed }))
    }
    const stored = yield* toolResult(RECORD.scope, RECORD.key)
    const record = yield* Schema.decodeUnknownEffect(DemoOwnerRecord)(stored?.result ?? '').pipe(
      Effect.mapError(() => setupError('the demo owner record is unreadable')),
    )
    const serialized = yield* unseal(secret, record.sealed)
    return yield* Effect.tryPromise({
      try: () => SoftPasskey.restore(serialized, site.rpId, site.origin),
      catch: () => setupError('the demo owner passkey does not restore'),
    })
  })

/** The demo wallet behind the passkey: found by its credential, or created through the registration path. */
export const demoWallet = (site: Site, passkey: SoftPasskey, say: Say) =>
  Effect.gen(function* () {
    const credentialId = Base64Url.encode(passkey.credentialId)
    const existing = yield* walletByCredential(credentialId)
    if (existing !== undefined) return { wallet: existing, token: yield* createSession(existing.owner_id) }
    const options = yield* registrationOptions(site, DEMO_WALLET_NAME)
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: site.origin,
        crossOrigin: false,
      }),
    )
    const created = yield* createWallet(site, {
      name: DEMO_WALLET_NAME,
      credentialId,
      publicKey: Base64Url.encode(passkey.publicKey65),
      clientDataJSON: Base64Url.encode(clientData),
    })
    const network = yield* Network
    const wallet = created.wallet
    yield* say({
      step: '0',
      title: 'Nod created its demo wallet',
      tool: 'passkey registration → createWallet',
      state: 'ok',
      amount: null,
      fee: 'Nod paid the network fee',
      detail: `A Stellar smart account whose owner is the demo passkey: ${wallet.contract_id}. It starts with Alice, Bob and Carol as contacts.`,
      links: [
        { label: 'deploy', url: `${network.explorerBase}/tx/${wallet.deploy_tx ?? ''}` },
        ...(wallet.fund_tx === null || wallet.fund_tx === undefined
          ? []
          : [{ label: 'welcome USDC', url: `${network.explorerBase}/tx/${wallet.fund_tx}` }]),
      ].filter(link => !link.url.endsWith('/tx/')),
    })
    return created
  })

/** Alice, Bob and Carol as the stage's seeds name them now (a reset Carol has a new address). */
export const syncContacts = (ownerId: string) =>
  Effect.gen(function* () {
    const settings = yield* WalletSettings
    const chain = yield* Chain
    const saved = yield* searchContacts(ownerId, '')
    for (const seed of settings.demoContacts) {
      const readiness = yield* chain.readiness(seed.address).pipe(
        Effect.map(found => (found === 'contract' ? ('usdc_ready' as const) : found)),
        Effect.catchTag('ChainError', () => Effect.succeed('unverified' as const)),
      )
      const contact = saved.find(candidate => candidate.display_name === seed.name)
      if (contact === undefined)
        yield* createContact({
          ownerId,
          displayName: seed.name,
          aliases: ['demo contact'],
          address: seed.address,
          memo: null,
          readiness,
        })
      else if (contact.destinations[0]?.address !== seed.address)
        yield* replaceDestination({ ownerId, contactId: contact.id, address: seed.address, memo: null, readiness })
    }
  })

/** A fresh, unspent 5 USDC allowance with the 1.00 nod line that lives past this run. */
const usable = (grant: SpendingGrant | undefined, nowMs: number): grant is SpendingGrant =>
  grant !== undefined &&
  grant.status === 'active' &&
  grant.rule_status === 'installed' &&
  Date.parse(grant.valid_until) > nowMs + 30 * 60 * 1000 &&
  grant.total === toStroops(SAMPLE_AMOUNTS.allowance) &&
  grant.nod_above === toStroops(SAMPLE_AMOUNTS.nodAbove) &&
  grant.spent === 0n &&
  grant.reserved === 0n

/** The consent page's grant ceremony, with the demo passkey: K, rule install, pocket, connection. */
const installAllowance = (owner: DemoOwner, wallet: Wallet, say: Say) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    const network = yield* Network
    const total = toStroops(SAMPLE_AMOUNTS.allowance)
    const signer = yield* chain.newSigner
    const prepared = yield* chain.prepareInstallGrant(wallet.contract_id, signer.publicKey, total, ALLOWANCE_LIFETIME_S)
    const encoded = yield* Schema.encodeEffect(PreparedOwnerAuth)(prepared).pipe(
      Effect.mapError(() => setupError('could not store the prepared install')),
    )
    const pendingId = yield* createPendingGrant({
      owner_id: wallet.owner_id,
      wallet_id: wallet.id,
      signer_public_key: signer.address,
      signer_key_ref: signer.signerKeyRef,
      total,
      nod_above: toStroops(SAMPLE_AMOUNTS.nodAbove),
      valid_until: yield* isoIn(ALLOWANCE_LIFETIME_S * 1000),
      lifetime_seconds: ALLOWANCE_LIFETIME_S,
      prepared: JSON.stringify(encoded),
    })
    const pending = yield* pendingGrant(pendingId, wallet.owner_id)
    if (pending === undefined) return yield* setupError('the prepared allowance vanished')
    const answer = yield* passkeyAnswer(owner.passkey, prepared.challenge)
    const assertion = yield* checkAssertion(
      owner.site,
      wallet,
      {
        credentialId: answer.credential_id,
        clientDataJSON: answer.client_data_json,
        authenticatorData: answer.authenticator_data,
        signature: answer.signature,
      },
      prepared.challenge,
    )
    const installed = yield* chain.installGrant(prepared, assertion)
    const pocket = yield* chain.createPocket(pending.signer_key_ref).pipe(
      Effect.map((created): { readonly address: string; readonly tx: string } | null => created),
      Effect.catchTag('ChainError', error => Effect.as(Effect.logWarning('pocket not created', error.message), null)),
    )
    const connectionId = yield* randomId('con')
    yield* createConnection({
      connectionId,
      grantId: yield* randomId('gr'),
      ownerId: wallet.owner_id,
      walletId: wallet.id,
      clientId: SAMPLE_CLIENT.id,
      clientName: SAMPLE_CLIENT.name,
      clientDomain: null,
      oauthGrantId: connectionId,
      pending,
      ruleId: installed.ruleId,
      validUntilLedger: installed.validUntilLedger,
      installTx: installed.tx,
      pocketAddress: pocket?.address ?? null,
    })
    yield* say({
      step: '0',
      title: `The demo owner gives the sample agent an allowance of ${fromStroops(total)} USDC until tomorrow`,
      tool: 'consent: add_context_rule signed by the passkey',
      state: 'ok',
      amount: `${fromStroops(total)} USDC allowance`,
      fee: 'Nod paid the network fee',
      detail: `The rule (id ${installed.ruleId}) lives on the Stellar account: the agent's own key may move at most ${fromStroops(total)} USDC until it expires. Below ${fromStroops(pending.nod_above)} USDC it pays alone; ${fromStroops(pending.nod_above)} USDC or more, or anything past the allowance, needs the owner's nod.${pocket === null ? '' : ' The agent also gets a pocket account for x402 purchases.'}`,
      links: [
        { label: 'allowance installed', url: `${network.explorerBase}/tx/${installed.tx}` },
        ...(pocket === null ? [] : [{ label: 'pocket created', url: `${network.explorerBase}/tx/${pocket.tx}` }]),
      ],
    })
    return connectionId
  })

/**
 * The sample agent's connection for this run: reuse an unspent live allowance, else retire what is left (service
 * revoke, rule removal by the passkey) and install a new one. Every finished run revokes its own, so this is a new rule
 * per run.
 */
export const sampleConnection = (owner: DemoOwner, wallet: Wallet, say: Say) =>
  Effect.gen(function* () {
    const nowMs = yield* nowMillis
    const ours = (yield* connectionsOfWallet(wallet.id)).filter(
      ({ connection }) => connection.oauth_client_id === SAMPLE_CLIENT.id,
    )
    const reuse = ours.find(({ connection, grant }) => connection.status === 'active' && usable(grant, nowMs))
    for (const { connection, grant } of ours) {
      if (connection.id === reuse?.connection.id) continue
      if (connection.status === 'active') yield* revokeConnection(wallet.id, wallet.contract_id, connection.id)
      if (grant !== undefined && grant.rule_status !== 'removed')
        yield* removeRule(owner, connection.id).pipe(
          Effect.catchTag('OwnerPageError', error =>
            Effect.logWarning('sample: an old allowance rule was not removed', error.message),
          ),
        )
    }
    if (reuse !== undefined) return reuse.connection.id
    return yield* installAllowance(owner, wallet, say)
  })

/** The tool context the sample agent's calls run under, as /mcp builds it from the OAuth props. */
export const toolContext = (
  wallet: Wallet,
  connection: Connection,
  grant: SpendingGrant,
  origin: string,
): Effect.Effect<ToolContext> =>
  Effect.map(nowIso, (now): ToolContext => {
    const props: ConnectionProps = {
      owner_id: wallet.owner_id,
      wallet_id: wallet.id,
      connection_id: connection.id,
      client_id: connection.oauth_client_id,
      client_name: connection.oauth_client_name,
      client_domain: connection.oauth_client_domain,
      granted_at: now,
      grant: {
        grant_id: grant.id,
        allowance: fromStroops(grant.total),
        valid_until: grant.valid_until,
        rule_id: grant.rule_id,
        signer_public_key: grant.signer_public_key,
      },
    }
    return { props, origin }
  })

/** Testnet only: the treasury tops the demo wallet up to 30 USDC, keeping its floor for new wallets. */
export const topUp = (wallet: Wallet, say: Say) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    const network = yield* Network
    const floor = toStroops(SAMPLE_AMOUNTS.walletFloor)
    const balance = (yield* chain.balances(wallet.contract_id)).usdc
    if (balance >= floor) return balance
    if (network.name !== 'testnet') return yield* setupError('the demo wallet is only topped up on testnet')
    const need = floor - balance
    const treasury = (yield* chain.health).treasury
    const keep = toStroops(SAMPLE_LIMITS.treasuryFloorUsdc)
    if (treasury !== null && treasury.usdcStroops - need < keep)
      return yield* setupError(
        `Nod's testnet treasury holds ${fromStroops(treasury.usdcStroops)} USDC and keeps ${fromStroops(keep)} for new wallets, so sample runs are paused until it is refilled. The real thing still works: add Nod to Claude.`,
      )
    const funded = yield* chain.fundNewWallet(wallet.contract_id, need)
    yield* say({
      step: '0',
      title: `Nod's testnet treasury tops the demo wallet up to ${fromStroops(floor)} USDC`,
      tool: null,
      state: 'ok',
      amount: `${fromStroops(need)} USDC`,
      fee: 'the treasury paid its own fee',
      detail: `It held ${fromStroops(balance)} USDC; a run spends up to ${SAMPLE_AMOUNTS.runSpend}.`,
      links: [{ label: 'top-up', url: `${network.explorerBase}/tx/${funded.tx}` }],
    })
    return floor
  })
