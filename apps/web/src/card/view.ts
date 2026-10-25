import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { decimalUsdc, shortAddress } from '../format'
import { Message } from './message'
import { type Model, Shown } from './model'
import { amount, brandHeader, eyebrow, header, lead, note, pollStatus } from './view/parts'
import { paymentBody, paymentView, reasonQuote } from './view/payment'
import { purchaseView } from './view/purchase'
import { backButton, requestBody, requestsView, requestView } from './view/request'
import { topupView } from './view/topup'
import { allowanceLinkView, revokedView, walletView } from './view/wallet'

/** The card: the frame (theme, host variables, surface) around the view of whatever the tool returned. */

type Builder = HtmlBuilder<Message>

/** A recipient as the AI named it: a name stays a name, an address is shortened. */
const askedRecipient = (recipient: string): string =>
  /^[GCM][A-Z2-7]{55,}$/u.test(recipient) ? shortAddress(recipient) : recipient

/** payment_prepare before Nod answers: the amount and recipient the AI asked for, and what happens next. */
const askedPayment = (model: Model, amountAsked: string, h: Builder): ReadonlyArray<Html> => [
  brandHeader(h),
  eyebrow('Asked to pay', 'quiet', h),
  amount(decimalUsdc(amountAsked), h),
  Option.match(model.toolInput.maybeRecipient, {
    onNone: () => h.empty,
    onSome: recipient => h.p([h.Class('nod-recipient')], ['to ', h.strong([], [askedRecipient(recipient)])]),
  }),
  reasonQuote(model, Option.getOrNull(model.toolInput.maybeReason), h),
  pollStatus(model, 'Inside the allowance it pays on its own; past it, Nod asks for your passkey on its own page', h),
]

const waiting = (model: Model, h: Builder): ReadonlyArray<Html> =>
  Option.match(
    Option.filter(model.toolInput.maybeAmount, () =>
      Option.exists(model.maybeToolName, name => name === 'payment_prepare'),
    ),
    {
      onSome: amountAsked =>
        model.bridge._tag === 'Unavailable' ? waitingSkeleton(model, h) : askedPayment(model, amountAsked, h),
      onNone: () => waitingSkeleton(model, h),
    },
  )

const waitingSkeleton = (model: Model, h: Builder): ReadonlyArray<Html> => [
  brandHeader(h),
  model.bridge._tag === 'Unavailable'
    ? note(`This chat did not connect the card (${model.bridge.reason}). The AI has the full result.`, h)
    : h.div(
        [h.Class('nod-loading'), h.AriaLive('polite')],
        [
          h.div([h.Class('nod-skeleton nod-skeleton-wide')]),
          h.div([h.Class('nod-skeleton')]),
          h.span([h.Class('nod-visually-hidden')], ['Loading']),
        ],
      ),
]

const body = (model: Model, h: Builder): ReadonlyArray<Html> =>
  Shown.match<ReadonlyArray<Html>>(model.shown, {
    Waiting: () => waiting(model, h),
    ToolFailed: ({ message }) => [brandHeader(h), eyebrow('Nod could not do that', 'bad', h), lead(message, h)],
    Unrecognised: () => [
      brandHeader(h),
      note('Nod sent something this card cannot show. The AI has the full result.', h),
    ],
    Payment: ({ payment }) => paymentView(model, payment, h),
    Purchase: ({ purchase, maybePayment }) => purchaseView(model, purchase, maybePayment, h),
    Wallet: ({ overview }) =>
      Option.match(selectedInboxRequest(model), {
        onSome: request => [
          header(request.network, h),
          backButton('Wallet', Message.ClickedAllRequests(), h),
          ...requestBody(model, request, h),
        ],
        onNone: () => walletView(model, overview, h),
      }),
    AllowanceLink: ({ link }) => allowanceLinkView(model, link, h),
    Revoked: ({ revoke }) => revokedView(model, revoke, h),
    Request: ({ request }) => requestView(model, request, h),
    Requests: ({ requests }) => requestsView(model, requests, h),
    Topup: ({ topup }) => topupView(model, topup, h),
  })

/** On Home, the inbox request the person chose to review. */
const selectedInboxRequest = (model: Model) =>
  Option.flatMap(model.maybeSelectedRequestId, id => Array.findFirst(model.inbox, request => request.request_id === id))

/** A payment the card prepared itself (paying a request), over whatever the card showed before. */
const activePayment = (model: Model, h: Builder): Option.Option<ReadonlyArray<Html>> =>
  Option.map(model.maybeActivePayment, payment => [
    header(payment.network, h),
    backButton(model.surface === 'Home' ? 'Wallet' : 'Requests', Message.ClickedClosePayment(), h),
    ...paymentBody(model, payment, h),
  ])

export const view = (model: Model, h: Builder): Html =>
  h.main(
    [
      h.Class(
        ['nod', model.surface === 'Home' ? 'nod-home' : '', model.appearance.isFullscreen ? 'nod-fullscreen' : ''].join(
          ' ',
        ),
      ),
      h.DataAttribute(
        'theme',
        Option.match(model.appearance.maybeTheme, {
          onNone: () => 'auto',
          onSome: theme => (theme === 'Dark' ? 'dark' : 'light'),
        }),
      ),
      h.Style(model.appearance.variables),
    ],
    Option.getOrElse(activePayment(model, h), () => body(model, h)),
  )
