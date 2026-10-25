import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Message } from './message'
import { type Model, Shown } from './model'
import { eyebrow, header, lead, note } from './view/parts'
import { paymentView } from './view/payment'
import { purchaseView } from './view/purchase'
import { allowanceLinkView, revokedView, walletView } from './view/wallet'

/** The card: the frame (theme, host variables, surface) around the view of whatever the tool returned. */

type Builder = HtmlBuilder<Message>

const DEFAULT_NETWORK = 'stellar:testnet'

const waiting = (model: Model, h: Builder): ReadonlyArray<Html> => [
  header(DEFAULT_NETWORK, h),
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
    ToolFailed: ({ message }) => [
      header(DEFAULT_NETWORK, h),
      eyebrow('Nod could not do that', 'bad', h),
      lead(message, h),
    ],
    Unrecognised: () => [
      header(DEFAULT_NETWORK, h),
      note('Nod sent something this card cannot show. The AI has the full result.', h),
    ],
    Payment: ({ payment }) => paymentView(model, payment, h),
    Purchase: ({ purchase, maybePayment }) => purchaseView(model, purchase, maybePayment, h),
    Wallet: ({ overview }) => walletView(model, overview, h),
    AllowanceLink: ({ link }) => allowanceLinkView(model, link, h),
    Revoked: ({ revoke }) => revokedView(model, revoke, h),
  })

export const view = (model: Model, h: Builder): Html =>
  h.main(
    [
      h.Class(model.surface === 'Home' || model.appearance.isFullscreen ? 'nod nod-home' : 'nod'),
      h.DataAttribute(
        'theme',
        Option.match(model.appearance.maybeTheme, {
          onNone: () => 'auto',
          onSome: theme => (theme === 'Dark' ? 'dark' : 'light'),
        }),
      ),
      h.Style(model.appearance.variables),
    ],
    body(model, h),
  )
