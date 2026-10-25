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
  headline,
  lead,
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

/** Who sells it: the URL's host, or the MCP server's host and tool. */
const sellerOf = (purchase: Purchase, input: ToolInput): string =>
  purchase.kind === 'Fetch'
    ? Option.match(input.maybeUrl, {
        onSome: hostOf,
        onNone: () =>
          purchase.receipt?.resource === null || purchase.receipt === null
            ? 'a paid resource'
            : hostOf(purchase.receipt.resource),
      })
    : Option.match(Option.all([input.maybeServerUrl, input.maybeTool]), {
        onSome: ([server, tool]) => `${tool} on ${hostOf(server)}`,
        onNone: () => 'a paid MCP tool',
      })

const priceFacts = (purchase: Purchase, input: ToolInput): ReadonlyArray<Fact> => {
  const price: ReadonlyArray<Fact> = purchase.price === null ? [] : [['Price', decimalUsdc(purchase.price)]]
  const limit: ReadonlyArray<Fact> = Option.match(input.maybeMaxAmount, {
    onNone: () => [],
    onSome: max => [['The AI’s limit', decimalUsdc(max)]],
  })
  return [...price, ...limit]
}

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

const pocketNote = (purchase: Purchase, h: Builder): Html =>
  purchase.pull === null
    ? h.empty
    : h.p(
        [h.Class('nod-note')],
        [
          `${decimalUsdc(purchase.pull.amount)} moved into this AI app's pocket and stays there for its next purchase. `,
          textLink(`${shortAddress(purchase.pull.tx_hash)} ↗`, purchase.pull.explorer_url, h),
        ],
      )

const awaiting = (model: Model, purchase: Purchase, seller: string, h: Builder): ReadonlyArray<Html> => [
  eyebrow('Needs your nod', 'nod', h),
  headline(seller, h),
  purchase.price === null ? h.empty : amount(decimalUsdc(purchase.price), h),
  reasonQuote(model, Option.getOrNull(model.toolInput.maybeReason), h),
  facts([...priceFacts(purchase, model.toolInput), allowanceLeft(model, purchase.grant_remaining, h)], h),
  purchase.approval_url === null
    ? h.empty
    : actions([primaryAction('Approve with your passkey ↗', purchase.approval_url, h)], h),
  linkFallback(model.link, h),
  note("Your passkey signs on Nod's own page, never in this chat. Nothing is paid until you approve.", h),
  pollStatus(model, 'Waiting for your nod', h),
]

/** After the owner's nod, the payment the card has been polling. */
const afterNod = (
  model: Model,
  purchase: Purchase,
  payment: PaymentView,
  seller: string,
  h: Builder,
): ReadonlyArray<Html> => {
  const phase = phaseOf(payment)
  if (phase === 'NeedsNod') {
    return awaiting(model, purchase, seller, h)
  }
  if (phase === 'Receipt' && payment.receipt !== null) {
    return [
      eyebrow('Bought', 'good', h),
      headline(seller, h),
      amount(decimalUsdc(payment.amount), h),
      facts(receiptFacts(payment.receipt, payment.grant_remaining, h), h),
      linkFallback(model.link, h),
    ]
  }
  if (phase === 'Failed' || phase === 'Expired') {
    return [
      eyebrow(phase === 'Expired' ? 'Expired' : 'Not bought', phase === 'Expired' ? 'quiet' : 'bad', h),
      headline(seller, h),
      lead(payment.failure ?? 'It expired before it was approved. Nothing was paid.', h),
    ]
  }
  return [
    eyebrow('Approved', 'good', h),
    headline(seller, h),
    amount(decimalUsdc(payment.amount), h),
    lead('You approved it with your passkey. The AI finishes the purchase next.', h),
  ]
}

const bought = (model: Model, purchase: Purchase, seller: string, h: Builder): ReadonlyArray<Html> => [
  eyebrow(purchase.status === 'free' ? 'Free' : 'Bought', purchase.status === 'free' ? 'quiet' : 'good', h),
  headline(seller, h),
  purchase.price === null ? h.empty : amount(decimalUsdc(purchase.price), h),
  facts(
    purchase.receipt === null
      ? priceFacts(purchase, model.toolInput)
      : [...priceFacts(purchase, model.toolInput), ...receiptFacts(purchase.receipt, purchase.grant_remaining, h)],
    h,
  ),
  preview(purchase, h),
  linkFallback(model.link, h),
]

const notBought = (model: Model, purchase: Purchase, seller: string, h: Builder): ReadonlyArray<Html> => [
  eyebrow('Not bought', 'bad', h),
  headline(seller, h),
  lead(purchase.message, h),
  purchase.facilitator_message === null ? h.empty : note(`The seller said: ${purchase.facilitator_message}`, h),
  facts([...priceFacts(purchase, model.toolInput), ['Allowance left', decimalUsdc(purchase.grant_remaining)]], h),
  pocketNote(purchase, h),
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
  const seller = sellerOf(purchase, model.toolInput)
  const network = Option.match(maybePayment, {
    onNone: () => networkOfPurchase(purchase),
    onSome: payment => payment.network,
  })
  const body = Option.match(maybePayment, {
    onSome: payment => afterNod(model, purchase, payment, seller, h),
    onNone: () => {
      if (purchase.status === 'requires_approval') {
        return awaiting(model, purchase, seller, h)
      }
      if (purchase.status === 'paid' || purchase.status === 'free') {
        return bought(model, purchase, seller, h)
      }
      return notBought(model, purchase, seller, h)
    },
  })
  return [header(network, h), ...body]
}
