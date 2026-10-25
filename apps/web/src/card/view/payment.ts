import { Match, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { PaymentView, ReceiptView } from '@hm/protocol'

import { decimalUsdc, shortAddress } from '../../format'
import type { Message } from '../message'
import type { Model } from '../model'
import { phaseOf, recipientName } from '../phase'
import {
  actions,
  allowanceLeft,
  amount,
  appName,
  details,
  eyebrow,
  type Fact,
  facts,
  header,
  lead,
  linkFallback,
  note,
  pollStatus,
  primaryAction,
  recipientLine,
  secondaryAction,
  textLink,
  time,
} from './parts'

/** `payment_prepare` (and the payment it becomes as the card polls `payment_status`). */

type Builder = HtmlBuilder<Message>

/** The AI's reason, shown as its words and not Nod's. */
export const reasonQuote = (model: Model, reason: string | null, h: Builder): Html =>
  reason === null
    ? h.empty
    : h.figure(
        [h.Class('nod-quote')],
        [
          h.figcaption(
            [],
            [
              Option.match(appName(model), {
                onNone: () => "The AI app's reason, not checked by Nod",
                onSome: name => `${name}'s reason, not checked by Nod`,
              }),
            ],
          ),
          h.blockquote([], [reason]),
        ],
      )

export const receiptFacts = (receipt: ReceiptView, grantRemaining: string, h: Builder): ReadonlyArray<Fact> => {
  const pull: ReadonlyArray<Fact> =
    receipt.pull_tx_hash !== null && receipt.pull_explorer_url !== null
      ? [['Into the pocket', textLink(`${shortAddress(receipt.pull_tx_hash)} ↗`, receipt.pull_explorer_url, h)]]
      : []
  return [
    ['Confirmed', time(receipt.confirmed_at, h)],
    [
      'Network fee',
      receipt.fee_paid_by === 'relayer' ? `Nod paid it (${receipt.fee_xlm} XLM)` : 'The seller’s facilitator paid it',
    ],
    ['Allowance left', decimalUsdc(grantRemaining)],
    ['Transaction', textLink(`${shortAddress(receipt.tx_hash)} ↗`, receipt.explorer_url, h)],
    ...pull,
    ['Ledger', h.span([h.Class('nod-number')], [String(receipt.ledger)])],
  ]
}

/** Why this payment waits for the passkey, in the words the owner needs to decide. */
const nodReason = (model: Model, payment: PaymentView): string => {
  const app = Option.getOrElse(appName(model), () => 'this AI app')
  return Match.value(payment.approval_reason ?? null).pipe(
    Match.withReturnType<string>(),
    Match.when(
      'recipient_not_ready',
      () =>
        `${payment.recipient.name ?? 'The recipient'} has no USDC trustline yet, so this payment needs your passkey.`,
    ),
    Match.when('no_allowance', () => `There is no allowance for ${app} right now, so this payment needs your passkey.`),
    Match.when('owner_only', () => 'A payment like this one always needs your passkey.'),
    Match.orElse(
      () =>
        `It is more than ${app} may still spend on its own (${decimalUsdc(payment.grant_remaining)}), so it needs your passkey.`,
    ),
  )
}

const needsNod = (model: Model, payment: PaymentView, h: Builder): ReadonlyArray<Html> => [
  eyebrow('Needs your nod', 'nod', h),
  amount(decimalUsdc(payment.amount), h),
  recipientLine(payment.recipient.name, payment.recipient.address, h),
  h.div(
    [h.Class('nod-address')],
    [h.p([h.Class('nod-label')], ['Full address']), h.p([h.Class('nod-mono nod-select')], [payment.recipient.address])],
  ),
  lead(nodReason(model, payment), h),
  reasonQuote(model, payment.reason, h),
  facts([['Open until', time(payment.expires_at, h)]], h),
  payment.claim_url === null
    ? h.empty
    : note(
        `${payment.recipient.name ?? 'The recipient'} has no USDC trustline yet. After you approve, they accept it on a claim link.`,
        h,
      ),
  payment.approval_url === null
    ? h.empty
    : actions([primaryAction('Approve with your passkey ↗', payment.approval_url, h)], h),
  linkFallback(model.link, h),
  note("Your passkey signs on Nod's own page, never in this chat. Nod pays the network fee.", h),
  pollStatus(model, 'Waiting for your nod', h),
]

const receipt = (model: Model, payment: PaymentView, h: Builder): ReadonlyArray<Html> => [
  eyebrow(payment.lane === 'owner' ? 'Paid with your nod' : 'Paid inside the allowance', 'good', h),
  amount(decimalUsdc(payment.amount), h),
  recipientLine(payment.recipient.name, payment.recipient.address, h),
  payment.receipt === null ? h.empty : facts(receiptFacts(payment.receipt, payment.grant_remaining, h), h),
  payment.receipt === null
    ? h.empty
    : actions([secondaryAction('View on stellar.expert ↗', payment.receipt.explorer_url, h)], h),
  linkFallback(model.link, h),
]

const inFlight = (model: Model, payment: PaymentView, label: string, status: string, h: Builder) => [
  eyebrow(label, 'quiet', h),
  amount(decimalUsdc(payment.amount), h),
  recipientLine(payment.recipient.name, payment.recipient.address, h),
  reasonQuote(model, payment.reason, h),
  facts([allowanceLeft(model, payment.grant_remaining, h)], h),
  pollStatus(model, status, h),
]

const claim = (model: Model, payment: PaymentView, h: Builder): ReadonlyArray<Html> => [
  eyebrow(`Approved · waiting for ${recipientName(payment)}`, 'quiet', h),
  amount(decimalUsdc(payment.amount), h),
  recipientLine(payment.recipient.name, payment.recipient.address, h),
  lead(
    `${payment.recipient.name ?? 'The recipient'} has no USDC trustline yet, so they accept the payment on a claim link. Send it to them if they don't have it.`,
    h,
  ),
  payment.claim_url === null ? h.empty : actions([secondaryAction('Claim link ↗', payment.claim_url, h)], h),
  linkFallback(model.link, h),
  pollStatus(model, `Waiting for ${recipientName(payment)} to accept`, h),
]

const ended = (payment: PaymentView, label: string, explanation: string, h: Builder): ReadonlyArray<Html> => [
  eyebrow(label, label === 'Expired' ? 'quiet' : 'bad', h),
  amount(decimalUsdc(payment.amount), h),
  recipientLine(payment.recipient.name, payment.recipient.address, h),
  lead(explanation, h),
  payment.failure === null ? h.empty : details('What Stellar said', payment.failure, h),
]

export const paymentBody = (model: Model, payment: PaymentView, h: Builder): ReadonlyArray<Html> =>
  Match.value(phaseOf(payment)).pipe(
    Match.withReturnType<ReadonlyArray<Html>>(),
    Match.when('NeedsNod', () => needsNod(model, payment, h)),
    Match.when('Ready', () => inFlight(model, payment, 'Inside the allowance', 'Ready: the AI pays this next', h)),
    Match.when('Paying', () => inFlight(model, payment, 'Paying', 'Sending on Stellar', h)),
    Match.when('Approved', () => [
      eyebrow('Approved', 'good', h),
      amount(decimalUsdc(payment.amount), h),
      lead('You approved it with your passkey. The AI finishes the purchase next.', h),
    ]),
    Match.when('Claim', () => claim(model, payment, h)),
    Match.when('Receipt', () => receipt(model, payment, h)),
    Match.when('Failed', () => ended(payment, 'Not paid', 'The payment failed. Nothing was paid.', h)),
    Match.when('Expired', () => ended(payment, 'Expired', 'It expired before it was approved. Nothing was paid.', h)),
    Match.exhaustive,
  )

export const paymentView = (model: Model, payment: PaymentView, h: Builder): ReadonlyArray<Html> => [
  header(payment.network, h),
  ...paymentBody(model, payment, h),
]
