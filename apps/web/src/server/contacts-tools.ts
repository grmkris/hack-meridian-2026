import { Effect, Schema } from 'effect'

import {
  Chain,
  type Contact,
  type ContactAddInput,
  ContactChangeOutput,
  type ContactRemoveInput,
  type ContactUpdateInput,
  type ContactView,
  fromStroops,
  type Readiness,
  toStroops,
} from '@hm/protocol'

import { nowMillis } from './clock.ts'
import { accountStatusOf, depositView, ensureDepositAddress, pendingOf, watchDeposit } from './deposit.ts'
import { Network } from './network.ts'
import {
  createContact,
  intentsOfWallet,
  knownAddress,
  receiptOfIntent,
  removeContact,
  renameContact,
  replaceDestination,
  saveToolResult,
  searchContacts,
  toolResult,
} from './store.ts'
import { scope, ToolError, type ToolContext } from './tools.ts'
import { grantRemaining, paymentView, toolGrantView } from './views.ts'

/**
 * The six tools after the first fifteen (K2, 2026-10-25 18:05: MCP is the main interface): contact_add,
 * contact_update and contact_remove (an AI app's contacts carry its name, and the first payment to an address it saved
 * needs the user's nod unless the wallet already knows it, tools.ts firstPaymentToAiContact), wallet_deposit_address,
 * payments_list and connection_grant_update (a link the passkey signs; allowance-page.ts installs it).
 */

const fail = (message: string) => Effect.fail(new ToolError({ message }))

/** The tool's earlier answer under this idempotency key, if any (same key, same answer; another tool's key refused). */
const replayed = (connectionId: string, key: string, tool: string) =>
  Effect.gen(function* () {
    const saved = yield* toolResult(connectionId, key)
    if (saved === undefined) return undefined
    if (saved.tool !== tool) return yield* fail(`Idempotency key ${key} was used for ${saved.tool}; use a new key.`)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ContactChangeOutput))(saved.result).pipe(
      Effect.mapError(() => new ToolError({ message: `The earlier ${tool} answer is unreadable; use a new key.` })),
    )
  })

const remember = (connectionId: string, key: string, tool: string, value: typeof ContactChangeOutput.Type) =>
  Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ContactChangeOutput))(value), json =>
    saveToolResult(connectionId, key, tool, json),
  ).pipe(Effect.orDie)

const view = (contact: Contact): ContactView => ({
  contact_id: contact.id,
  name: contact.display_name,
  aliases: contact.aliases,
  destinations: contact.destinations.map(destination => ({
    address: destination.address,
    network: destination.network,
    memo: destination.memo,
    readiness: destination.last_paid_at === null ? [destination.readiness] : [destination.readiness, 'paid_before'],
    last_paid_at: destination.last_paid_at,
  })),
  added_by: contact.added_by ?? null,
})

const readinessOf = (address: string) =>
  Chain.use(chain => chain.readiness(address)).pipe(
    Effect.map((readiness): Readiness => (readiness === 'contract' ? 'usdc_ready' : readiness)),
    Effect.orElseSucceed((): Readiness => 'unverified'),
  )

/** A contact by id, name or alias (exact, case-insensitive); one or a sentence that says why not. */
const findContact = (ownerId: string, ref: string) =>
  Effect.gen(function* () {
    const needle = ref.trim().toLowerCase()
    const all = yield* searchContacts(ownerId, '')
    const matches = all.filter(
      contact =>
        contact.id === ref.trim() ||
        contact.display_name.toLowerCase() === needle ||
        contact.aliases.some(alias => alias.toLowerCase() === needle),
    )
    if (matches.length > 1)
      return yield* fail(
        `"${ref}" matches ${matches.map(contact => contact.display_name).join(', ')}; use its contact_id.`,
      )
    const contact = matches[0]
    if (contact === undefined) return yield* fail(`No saved contact is called "${ref}". Use contacts_search.`)
    return { contact, all }
  })

const firstPaymentSentence = (name: string, known: boolean) =>
  known
    ? `The wallet already knows this address, so payments to ${name} inside the allowance go through.`
    : `Saved by this AI app: the first payment to ${name} needs the user's nod (their passkey), whatever the amount.`

// 16. contact_add

export const contactAdd = (ctx: ToolContext, input: ContactAddInput) =>
  Effect.gen(function* () {
    const { connection, wallet, grant, nowMs } = yield* scope(ctx, true)
    const again = yield* replayed(connection.id, input.idempotency_key, 'contact_add')
    if (again !== undefined) return { sentence: again.message, value: again }
    const name = input.name.trim()
    const address = input.address.trim()
    if (address === wallet.contract_id) return yield* fail('That is this wallet itself.')
    const all = yield* searchContacts(ctx.props.owner_id, '')
    const sameAddress = all.find(contact => contact.destinations.some(destination => destination.address === address))
    if (sameAddress !== undefined) {
      const value = {
        contact: view(sameAddress),
        result: 'unchanged' as const,
        message: `${address} is already saved as ${sameAddress.display_name}; nothing changed.`,
        grant_remaining: grantRemaining(grant, nowMs),
      }
      yield* remember(connection.id, input.idempotency_key, 'contact_add', value)
      return { sentence: value.message, value }
    }
    const sameName = all.find(contact => contact.display_name.toLowerCase() === name.toLowerCase())
    if (sameName !== undefined)
      return yield* fail(
        `A contact named ${sameName.display_name} already exists (contact_id ${sameName.id}). Use contact_update to change its address, or pick another name.`,
      )
    const contact = yield* createContact({
      ownerId: ctx.props.owner_id,
      displayName: name,
      aliases: input.aliases ?? [],
      address,
      memo: null,
      readiness: yield* readinessOf(address),
      addedBy: { name: connection.oauth_client_name, connectionId: connection.id },
      source: 'ai',
    })
    const value = {
      contact: view(contact),
      result: 'added' as const,
      message: `Saved ${name} (${address}). ${firstPaymentSentence(name, yield* knownAddress(wallet.id, address))}`,
      grant_remaining: grantRemaining(grant, nowMs),
    }
    yield* remember(connection.id, input.idempotency_key, 'contact_add', value)
    return { sentence: value.message, value }
  })

// 17. contact_update

export const contactUpdate = (ctx: ToolContext, input: ContactUpdateInput) =>
  Effect.gen(function* () {
    const { connection, wallet, grant, nowMs } = yield* scope(ctx, true)
    const again = yield* replayed(connection.id, input.idempotency_key, 'contact_update')
    if (again !== undefined) return { sentence: again.message, value: again }
    const { contact, all } = yield* findContact(ctx.props.owner_id, input.contact)
    const name = input.name?.trim()
    if (
      name !== undefined &&
      all.some(other => other.id !== contact.id && other.display_name.toLowerCase() === name.toLowerCase())
    )
      return yield* fail(`Another contact is already called ${name}.`)
    const address = input.address?.trim()
    if (address === wallet.contract_id) return yield* fail('That is this wallet itself.')
    const addressChanges = address !== undefined && !contact.destinations.some(d => d.address === address)
    const notes: Array<string> = []
    if (addressChanges)
      yield* replaceDestination({
        ownerId: ctx.props.owner_id,
        contactId: contact.id,
        address,
        memo: null,
        readiness: yield* readinessOf(address),
        source: 'ai',
      })
    if (name !== undefined || input.aliases !== undefined)
      yield* renameContact({
        ownerId: ctx.props.owner_id,
        contactId: contact.id,
        displayName: name,
        aliases: input.aliases,
      })
    const updated = (yield* searchContacts(ctx.props.owner_id, '')).find(other => other.id === contact.id) ?? contact
    const changed =
      addressChanges || (name !== undefined && name !== contact.display_name) || input.aliases !== undefined
    if (addressChanges && address !== undefined)
      notes.push(
        `New address ${address}. ${firstPaymentSentence(updated.display_name, yield* knownAddress(wallet.id, address))}`,
      )
    const value = {
      contact: view(updated),
      result: changed ? ('updated' as const) : ('unchanged' as const),
      message: changed ? `Updated ${updated.display_name}. ${notes.join(' ')}`.trim() : 'Nothing to change.',
      grant_remaining: grantRemaining(grant, nowMs),
    }
    yield* remember(connection.id, input.idempotency_key, 'contact_update', value)
    return { sentence: value.message, value }
  })

// 18. contact_remove

export const contactRemove = (ctx: ToolContext, input: ContactRemoveInput) =>
  Effect.gen(function* () {
    const { connection, grant, nowMs } = yield* scope(ctx, true)
    const again = yield* replayed(connection.id, input.idempotency_key, 'contact_remove')
    if (again !== undefined) return { sentence: again.message, value: again }
    const { contact } = yield* findContact(ctx.props.owner_id, input.contact)
    yield* removeContact(ctx.props.owner_id, contact.id)
    const value = {
      contact: view(contact),
      result: 'removed' as const,
      message: `Removed ${contact.display_name} from the user's contacts. Payments already made keep their receipts.`,
      grant_remaining: grantRemaining(grant, nowMs),
    }
    yield* remember(connection.id, input.idempotency_key, 'contact_remove', value)
    return { sentence: value.message, value }
  })

// 19. wallet_deposit_address

export const walletDepositAddress = (ctx: ToolContext) =>
  Effect.gen(function* () {
    const { wallet, grant, nowMs } = yield* scope(ctx, false)
    const network = yield* Network
    const chain = yield* Chain
    const base = {
      network: network.caip,
      wallet_contract_id: wallet.contract_id,
      account_status: yield* accountStatusOf(wallet.id),
      grant_remaining: grantRemaining(grant, nowMs),
    }
    if (!chain.depositsAvailable) {
      const value = {
        ...base,
        status: 'unavailable' as const,
        address: null,
        expires_at: null,
        pending: null,
        received_total: '0.00',
        message: `Nod has no deposit addresses on ${network.label} yet. The user can send USDC straight to the wallet address ${wallet.contract_id} from a wallet that pays contract addresses (Freighter).`,
      }
      return { sentence: value.message, value }
    }
    const row = yield* ensureDepositAddress(wallet).pipe(
      Effect.catchTag('DepositError', error =>
        fail(
          error.reason === 'busy'
            ? 'The deposit address is being created right now; call wallet_deposit_address again in a few seconds.'
            : `Could not create the deposit address (${error.message}); try again.`,
        ),
      ),
    )
    yield* watchDeposit(wallet.id)
    const shown = depositView(row, yield* pendingOf(row))
    const value = {
      ...base,
      status: 'active' as const,
      address: shown.address,
      expires_at: shown.expires_at,
      pending: shown.pending === null ? null : fromStroops(BigInt(shown.pending)),
      received_total: fromStroops(BigInt(shown.swept_total)),
      message: `Send USDC on Stellar ${network.label} to ${shown.address}, from any exchange or wallet, any amount, no memo. It lands in the Nod wallet within about a minute while Nod watches the address (a day from now; later deposits wait there safely until the user opens Nod). It works until ${shown.expires_at}.${base.account_status === 'awaiting_deposit' ? ' The wallet opens with its first USDC.' : ''}`,
    }
    return { sentence: value.message, value }
  })

// 20. payments_list

export const paymentsList = (ctx: ToolContext, input: { readonly limit?: number; readonly all_apps?: boolean }) =>
  Effect.gen(function* () {
    const { connection, wallet, grant, nowMs } = yield* scope(ctx, false)
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
    const intents = yield* intentsOfWallet(wallet.id, limit, input.all_apps === true ? undefined : connection.id)
    const payments = yield* Effect.forEach(intents, intent =>
      Effect.map(receiptOfIntent(intent.id), receipt => paymentView(intent, receipt, grant, ctx.origin, nowMs)),
    )
    const summary = payments
      .slice(0, 3)
      .map(
        payment =>
          `${payment.amount} USDC to ${payment.recipient.name ?? payment.recipient.address} (${payment.status})`,
      )
      .join('; ')
    return {
      sentence:
        payments.length === 0
          ? `No payments ${input.all_apps === true ? 'from this wallet' : 'by this AI app'} yet.`
          : `${payments.length} payment(s), newest first: ${summary}${payments.length > 3 ? '; …' : ''}. Each confirmed one has its receipt and explorer link.`,
      value: { payments, grant_remaining: grantRemaining(grant, nowMs) },
    }
  })

// 21. connection_grant_update

export const allowanceUrl = (origin: string, connectionId: string, amount: string, hours: number) =>
  `${origin}/approve/allowance/${connectionId}?amount=${encodeURIComponent(amount)}&hours=${hours}`

export const connectionGrantUpdate = (
  ctx: ToolContext,
  input: { readonly amount?: string; readonly valid_for_hours?: number; readonly idempotency_key: string },
) =>
  Effect.gen(function* () {
    const { connection, grant } = yield* scope(ctx, true)
    const network = yield* Network
    const amount = input.amount ?? (grant === undefined ? undefined : fromStroops(grant.total))
    if (amount === undefined) return yield* fail('Say the new allowance: there is no current one to keep.')
    const stroops = toStroops(amount)
    if (stroops <= 0n) return yield* fail('The allowance must be more than zero.')
    if (stroops > network.caps.maxGrantStroops)
      return yield* fail(`Nod caps an allowance at ${fromStroops(network.caps.maxGrantStroops)} USDC.`)
    const hours = input.valid_for_hours ?? 24
    const url = allowanceUrl(ctx.origin, connection.id, fromStroops(stroops), hours)
    const nowMs = yield* nowMillis
    const value = {
      url,
      requested: { amount: fromStroops(stroops), valid_for_hours: hours },
      grant: grant === undefined ? null : toolGrantView(grant, nowMs),
      message: `This tool changes nothing itself. Ask the user to open ${url}: their passkey signs a new allowance of ${fromStroops(stroops)} USDC for ${hours} hours for this AI app, which replaces the current one.`,
      grant_remaining: grantRemaining(grant, nowMs),
    }
    yield* saveToolResult(connection.id, input.idempotency_key, 'connection_grant_update', JSON.stringify(value))
    return { sentence: value.message, value }
  })
