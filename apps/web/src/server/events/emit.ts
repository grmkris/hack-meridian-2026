import { fromStroops } from '@hm/protocol'

import type { JournalEvent } from './journal.ts'

/**
 * The events Nod writes, one builder each: the deterministic event id, Nod's own title/summary/url for the notice and
 * the payload fields the catalog describes. Links to Nod's own pages are paths (`/approve/…`), resolved against the
 * reader's origin when served; explorer links are absolute. Names in the text are the owner's own contact names only.
 */

export interface Counterparty {
  readonly address: string
  /** The owner's saved name for this address, or null. */
  readonly contact_name: string | null
}

const TITLE = 200
const SUMMARY = 1200
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** `CCHE…SO4Q`: an address short enough for a line of text. */
export const shortAddress = (address: string) =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address

const who = (party: Counterparty) => party.contact_name ?? shortAddress(party.address)

/** "testnet" / "mainnet" for a CAIP-2 Stellar network. */
export const networkWord = (network: string) => (network === 'stellar:pubnet' ? 'mainnet' : 'testnet')

const notice = (title: string, summary: string, url: string, network: string, walletId: string) => ({
  title: clip(title, TITLE),
  summary: clip(summary, SUMMARY),
  url,
  network,
  wallet_id: walletId,
})

const party = (counterparty: Counterparty) => ({
  address: counterparty.address,
  contact_name: counterparty.contact_name,
})

export const paymentReceived = (input: {
  readonly walletId: string
  readonly network: string
  readonly amount: bigint
  readonly from: Counterparty
  readonly tx: string
  readonly explorer: string
  readonly occurredAt: string
}): JournalEvent => {
  const amount = fromStroops(input.amount)
  return {
    eventId: `payment.received:${input.tx}:${input.walletId}`,
    walletId: input.walletId,
    name: 'payment.received',
    occurredAt: input.occurredAt,
    data: {
      ...notice(
        `Received ${amount} USDC from ${who(input.from)}`,
        `${amount} USDC arrived in your Nod wallet from ${who(input.from)} on ${networkWord(input.network)}.`,
        input.explorer,
        input.network,
        input.walletId,
      ),
      amount,
      asset: 'USDC',
      counterparty: party(input.from),
      tx: input.tx,
      explorer: input.explorer,
    },
  }
}

export const paymentSettled = (input: {
  readonly walletId: string
  readonly network: string
  readonly paymentId: string
  readonly status: 'confirmed' | 'failed'
  readonly amount: bigint
  readonly to: Counterparty
  readonly tx: string | null
  readonly explorer: string | null
  readonly occurredAt: string
}): JournalEvent => {
  const amount = fromStroops(input.amount)
  const confirmed = input.status === 'confirmed'
  return {
    eventId: `payment.settled:${input.paymentId}:${input.status}`,
    walletId: input.walletId,
    name: 'payment.settled',
    occurredAt: input.occurredAt,
    data: {
      ...notice(
        confirmed ? `Paid ${amount} USDC to ${who(input.to)}` : `Payment of ${amount} USDC to ${who(input.to)} failed`,
        confirmed
          ? `${amount} USDC from your Nod wallet reached ${who(input.to)} on ${networkWord(input.network)}.`
          : `Nod could not pay ${amount} USDC to ${who(input.to)} on ${networkWord(input.network)}; nothing left the wallet.`,
        input.explorer ?? '/receipts',
        input.network,
        input.walletId,
      ),
      payment_id: input.paymentId,
      status: input.status,
      amount,
      asset: 'USDC',
      counterparty: party(input.to),
      tx: input.tx,
      explorer: input.explorer,
    },
  }
}

export const approvalNeeded = (input: {
  readonly walletId: string
  readonly network: string
  readonly paymentId: string
  /** A purchase (x402) or a payment to a recipient. */
  readonly purchase: boolean
  readonly amount: bigint
  readonly to: Counterparty
  readonly expiresAt: string
  readonly occurredAt: string
}): JournalEvent => {
  const amount = fromStroops(input.amount)
  const what = input.purchase ? `a ${amount} USDC purchase` : `${amount} USDC to ${who(input.to)}`
  return {
    eventId: `approval.needed:${input.paymentId}`,
    walletId: input.walletId,
    name: 'approval.needed',
    occurredAt: input.occurredAt,
    data: {
      ...notice(
        `Needs your nod: ${input.purchase ? `${amount} USDC purchase` : `${amount} USDC to ${who(input.to)}`}`,
        `An AI app asked your Nod wallet to pay ${what} on ${networkWord(input.network)}. Open the link and approve it with your passkey, or let it lapse.`,
        `/approve/${input.paymentId}`,
        input.network,
        input.walletId,
      ),
      payment_id: input.paymentId,
      amount,
      asset: 'USDC',
      counterparty: party(input.to),
      expires_at: input.expiresAt,
    },
  }
}

export const allowanceChanged = (input: {
  readonly walletId: string
  readonly network: string
  readonly connectionId: string
  readonly grantId: string
  readonly change: 'installed' | 'revoked' | 'low'
  readonly allowance: bigint
  readonly remaining: bigint
  readonly validUntil: string
  readonly occurredAt: string
}): JournalEvent => {
  const allowance = fromStroops(input.allowance)
  const remaining = fromStroops(input.remaining)
  const text = {
    installed: [
      `Allowance of ${allowance} USDC installed`,
      `An AI app can now spend up to ${allowance} USDC from your Nod wallet on ${networkWord(input.network)} without asking.`,
    ],
    revoked: [
      'Allowance revoked',
      `An AI app's ${allowance} USDC allowance on your Nod wallet was revoked; it can no longer spend without your nod.`,
    ],
    low: [
      `Allowance low: ${remaining} USDC left`,
      `An AI app has ${remaining} of its ${allowance} USDC allowance left on your Nod wallet; bigger payments will need your nod.`,
    ],
  }[input.change]
  return {
    eventId: `allowance.changed:${input.change}:${input.grantId}`,
    walletId: input.walletId,
    name: 'allowance.changed',
    occurredAt: input.occurredAt,
    data: {
      ...notice(text[0] ?? 'Allowance changed', text[1] ?? '', '/connections', input.network, input.walletId),
      connection_id: input.connectionId,
      change: input.change,
      allowance,
      remaining,
      valid_until: input.validUntil,
    },
  }
}

/** For payment requests (Phase 3): someone asked this wallet for money. */
export const requestReceived = (input: {
  readonly walletId: string
  readonly network: string
  readonly requestId: string
  readonly amount: bigint
  readonly from: Counterparty
  readonly expiresAt: string
  readonly url: string
  readonly occurredAt: string
}): JournalEvent => {
  const amount = fromStroops(input.amount)
  return {
    eventId: `request.received:${input.requestId}`,
    walletId: input.walletId,
    name: 'request.received',
    occurredAt: input.occurredAt,
    data: {
      ...notice(
        `${who(input.from)} asks you for ${amount} USDC`,
        `A payment request for ${amount} USDC from ${who(input.from)} reached your Nod wallet on ${networkWord(input.network)}. Open the link to pay or decline.`,
        input.url,
        input.network,
        input.walletId,
      ),
      request_id: input.requestId,
      amount,
      asset: 'USDC',
      counterparty: party(input.from),
      expires_at: input.expiresAt,
    },
  }
}

/** For payment requests (Phase 3): a request this wallet sent was paid or declined. */
export const requestAnswered = (input: {
  readonly walletId: string
  readonly network: string
  readonly requestId: string
  readonly status: 'paid' | 'declined'
  readonly amount: bigint
  readonly by: Counterparty
  readonly tx: string | null
  readonly explorer: string | null
  readonly url: string
  readonly occurredAt: string
}): JournalEvent => {
  const amount = fromStroops(input.amount)
  return {
    eventId: `request.answered:${input.requestId}:${input.status}`,
    walletId: input.walletId,
    name: 'request.answered',
    occurredAt: input.occurredAt,
    data: {
      ...notice(
        input.status === 'paid'
          ? `${who(input.by)} paid your request for ${amount} USDC`
          : `${who(input.by)} declined your request for ${amount} USDC`,
        input.status === 'paid'
          ? `Your payment request for ${amount} USDC was paid on ${networkWord(input.network)}.`
          : `Your payment request for ${amount} USDC was declined; nothing was paid.`,
        input.explorer ?? input.url,
        input.network,
        input.walletId,
      ),
      request_id: input.requestId,
      status: input.status,
      amount,
      asset: 'USDC',
      counterparty: party(input.by),
      tx: input.tx,
      explorer: input.explorer,
    },
  }
}
