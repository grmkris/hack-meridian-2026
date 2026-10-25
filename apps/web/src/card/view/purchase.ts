import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { PaymentView } from '@hm/protocol'

import { decimalUsdc, shortAddress } from '../../format'
import type { Message } from '../message'
import type { Model, Purchase, ToolInput } from '../model'
import { phaseOf } from '../phase'
import {
  actions,
  allowanceLeft,
  amount,
  eyebrow,
  type Fact,
  facts,
  header,
  lead,
  details,
  linkFallback,
  note,
  pollStatus,
  primaryAction,
  textLink,
} from './parts'
import { reasonQuote, receiptFacts } from './payment'

/** `paid_resource_fetch` and `paid_mcp_call`: an x402 purchase from a seller. */

type Builder = HtmlBuilder<Message>

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Who sells it, under the price: the URL's host, or the MCP tool and its server's host. */
const sellerLine = (purchase: Purchase, input: ToolInput, h: Builder): Html => {
  if (purchase.kind === 'Fetch') {
    const host = Option.match(input.maybeUrl, {
      onSome: hostOf,
      onNone: () =>
        purchase.receipt === null || purchase.receipt.resource === null
          ? 'a paid resource'
          : hostOf(purchase.receipt.resource),
    })
    return h.p([h.Class('nod-recipient')], ['from ', h.strong([], [host])])
  }
  return Option.match(Option.all([input.maybeServerUrl, input.maybeTool]), {
    onSome: ([server, tool]) =>
      h.p([h.Class('nod-recipient')], [h.code([h.Class('nod-mono')], [tool]), ' on ', h.strong([], [hostOf(server)])]),
    onNone: () => h.p([h.Class('nod-recipient')], ['a paid MCP tool']),
  })
}

/** The AI's own limit beside the price (the price itself is the card's headline amount). */
const limitFacts = (input: ToolInput): ReadonlyArray<Fact> =>
  Option.match(input.maybeMaxAmount, {
    onNone: () => [],
    onSome: max => [['The AI’s limit', decimalUsdc(max)]],
  })

const preview = (purchase: Purchase, h: Builder): Html =>
  Option.match(purchase.maybePreview, {
    onNone: () => h.empty,
    onSome: text =>
      h.details(
        [h.Class('nod-preview')],
        [
          h.summary(
            [],
            [
              purchase.kind === 'Fetch'
                ? `What it returned${purchase.content_type === null ? '' : ` (${purchase.content_type})`}`
                : 'What the tool returned',
            ],
          ),
          h.pre([], [text]),
        ],
      ),
  })

/** A pull into the pocket that happened although the purchase did not settle. */
const pocketFact = (purchase: Purchase, h: Builder): ReadonlyArray<Fact> =>
  purchase.pull === null
    ? []
    : [
        [
          'Into the pocket',
          h.span(
            [],
            [
              `${decimalUsdc(purchase.pull.amount)} · `,
              textLink(`${shortAddress(purchase.pull.tx_hash)} ↗`, purchase.pull.explorer_url, h),
            ],
          ),
        ],
      ]

const awaiting = (model: Model, purchase: Purchase, h: Builder): ReadonlyArray<Html> => [
  eyebrow('Needs your nod', 'nod', h),
  purchase.price === null ? h.empty : amount(decimalUsdc(purchase.price), h),
  sellerLine(purchase, model.toolInput, h),
  reasonQuote(model, Option.getOrNull(model.toolInput.maybeReason), h),
  facts([...limitFacts(model.toolInput), allowanceLeft(model, purchase.grant_remaining, h)], h),
  purchase.approval_url === null
    ? h.empty
    : actions([primaryAction('Approve with your passkey ↗', purchase.approval_url, h)], h),
  linkFallback(model.link, h),
  note("Your passkey signs on Nod's own page, never in this chat. Nothing is paid until you approve.", h),
  pollStatus(model, 'Waiting for your nod', h),
]

/** After the owner's nod, the payment the card has been polling. */
const afterNod = (model: Model, purchase: Purchase, payment: PaymentView, h: Builder): ReadonlyArray<Html> => {
  const phase = phaseOf(payment)
  if (phase === 'NeedsNod') {
    return awaiting(model, purchase, h)
  }
  if (phase === 'Receipt' && payment.receipt !== null) {
    return [
      eyebrow('Bought', 'good', h),
      amount(decimalUsdc(payment.amount), h),
      sellerLine(purchase, model.toolInput, h),
      facts(receiptFacts(payment.receipt, payment.grant_remaining, h), h),
      linkFallback(model.link, h),
    ]
  }
  if (phase === 'Failed' || phase === 'Expired') {
    return [
      eyebrow(phase === 'Expired' ? 'Expired' : 'Not bought', phase === 'Expired' ? 'quiet' : 'bad', h),
      sellerLine(purchase, model.toolInput, h),
      lead(payment.failure ?? 'It expired before it was approved. Nothing was paid.', h),
    ]
  }
  return [
    eyebrow('Approved', 'good', h),
    amount(decimalUsdc(payment.amount), h),
    sellerLine(purchase, model.toolInput, h),
    lead('You approved it with your passkey. The AI finishes the purchase next.', h),
  ]
}

const bought = (model: Model, purchase: Purchase, h: Builder): ReadonlyArray<Html> => [
  eyebrow(purchase.status === 'free' ? 'Free' : 'Bought', purchase.status === 'free' ? 'quiet' : 'good', h),
  purchase.price === null ? h.empty : amount(decimalUsdc(purchase.price), h),
  sellerLine(purchase, model.toolInput, h),
  facts(
    purchase.receipt === null
      ? limitFacts(model.toolInput)
      : [...limitFacts(model.toolInput), ...receiptFacts(purchase.receipt, purchase.grant_remaining, h)],
    h,
  ),
  preview(purchase, h),
  linkFallback(model.link, h),
]

const notBought = (model: Model, purchase: Purchase, h: Builder): ReadonlyArray<Html> => [
  eyebrow('Not bought', 'bad', h),
  purchase.price === null ? h.empty : amount(decimalUsdc(purchase.price), h),
  sellerLine(purchase, model.toolInput, h),
  lead(purchase.message, h),
  facts(
    [...limitFacts(model.toolInput), ...pocketFact(purchase, h), allowanceLeft(model, purchase.grant_remaining, h)],
    h,
  ),
  purchase.facilitator_message === null ? h.empty : details('What the seller said', purchase.facilitator_message, h),
  linkFallback(model.link, h),
]

/** A purchase result names no network; its receipt's explorer link does. */
const networkOfPurchase = (purchase: Purchase): string =>
  purchase.receipt?.explorer_url.includes('/explorer/public/') === true ? 'stellar:pubnet' : 'stellar:testnet'

export const purchaseView = (
  model: Model,
  purchase: Purchase,
  maybePayment: Option.Option<PaymentView>,
  h: Builder,
): ReadonlyArray<Html> => {
  const network = Option.match(maybePayment, {
    onNone: () => networkOfPurchase(purchase),
    onSome: payment => payment.network,
  })
  const body = Option.match(maybePayment, {
    onSome: payment => afterNod(model, purchase, payment, h),
    onNone: () => {
      if (purchase.status === 'requires_approval') {
        return awaiting(model, purchase, h)
      }
      if (purchase.status === 'paid' || purchase.status === 'free') {
        return bought(model, purchase, h)
      }
      return notBought(model, purchase, h)
    },
  })
  return [header(network, h), ...body]
}
