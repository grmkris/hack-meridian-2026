import { Array, Match, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { RequestView } from '@hm/protocol'

import { decimalUsdc, shortAddress } from '../../format'
import { Message } from '../message'
import type { Model, RequestAction } from '../model'
import {
  actions,
  amount,
  eyebrow,
  type Fact,
  facts,
  header,
  headline,
  linkFallback,
  note,
  secondaryAction,
  type Tone,
  textLink,
  time,
} from './parts'

/** `request_create`, `requests_list` and the Home inbox: payment requests between wallets. */

type Builder = HtmlBuilder<Message>

/** Who the other side is, as this wallet's owner knows them. */
const otherParty = (request: RequestView): string => {
  const other = request.direction === 'incoming' ? request.requester : request.payer
  if (other.contact_name !== null) {
    return other.contact_name
  }
  return request.direction === 'incoming' && request.payer_is_nod_wallet
    ? 'A Nod wallet you have not saved'
    : shortAddress(other.address)
}

const STATUS_LABEL: Readonly<Record<RequestView['status'], readonly [string, Tone]>> = {
  open: ['Open', 'quiet'],
  paid: ['Paid', 'good'],
  declined: ['Declined', 'bad'],
  expired: ['Expired', 'quiet'],
}

const theirNote = (request: RequestView, h: Builder): Html =>
  request.note === null
    ? h.empty
    : h.figure(
        [h.Class('nod-quote')],
        [
          h.figcaption([], [request.direction === 'incoming' ? 'Their note, not checked by Nod' : 'Your note']),
          h.blockquote([], [request.note]),
        ],
      )

const receiptFact = (request: RequestView, h: Builder): ReadonlyArray<Fact> =>
  request.receipt === null
    ? []
    : [['Paid', textLink(`${shortAddress(request.receipt.tx_hash)} ↗`, request.receipt.explorer_url, h)]]

const canAct = (model: Model): boolean => model.bridge._tag === 'Connected' && model.bridge.capabilities.canCallTools

const button = (label: string, message: Message, isPrimary: boolean, h: Builder): Html =>
  h.button(
    [h.Type('button'), h.Class(isPrimary ? 'nod-button nod-button-primary' : 'nod-button'), h.OnClick(message)],
    [label],
  )

/** Pay or decline an incoming open request: one tap to ask, one to confirm; a failure keeps its key for the retry. */
const incomingActions = (model: Model, request: RequestView, h: Builder): ReadonlyArray<Html> => {
  if (!canAct(model)) {
    return [actions([secondaryAction('Open the request on Nod ↗', request.request_url, h)], h)]
  }
  const who = otherParty(request)
  const amountText = decimalUsdc(request.amount)
  const idle = [
    actions(
      [
        button(
          `Pay ${amountText}`,
          Message.ClickedRequestAction({ requestId: request.request_id, kind: 'Pay' }),
          false,
          h,
        ),
        button('Decline', Message.ClickedRequestAction({ requestId: request.request_id, kind: 'Decline' }), false, h),
      ],
      h,
    ),
  ]
  const forThis = (action: RequestAction): boolean => action._tag !== 'Idle' && action.requestId === request.request_id
  if (!forThis(model.requestAction)) {
    return idle
  }
  return Match.value(model.requestAction).pipe(
    Match.withReturnType<ReadonlyArray<Html>>(),
    Match.tag('Idle', () => idle),
    Match.tag('Confirming', ({ kind }) => [
      h.div(
        [h.Class('nod-confirm'), h.Role('group'), h.AriaLabel(kind === 'Pay' ? 'Confirm payment' : 'Confirm decline')],
        [
          h.p(
            [],
            [
              kind === 'Pay'
                ? `Pay ${amountText} to ${who}? Nod prepares it; if it needs your nod, you approve it with your passkey next.`
                : `Decline ${who}'s request for ${amountText}? They see it declined.`,
            ],
          ),
          actions(
            [
              button(
                kind === 'Pay' ? `Yes, pay ${amountText}` : 'Yes, decline',
                Message.ClickedConfirmRequestAction(),
                kind === 'Pay',
                h,
              ),
              button('Cancel', Message.ClickedCancelRequestAction(), false, h),
            ],
            h,
          ),
        ],
      ),
    ]),
    Match.tag('Sending', ({ kind }) => [
      h.p(
        [h.Class('nod-status'), h.AriaLive('polite')],
        [h.span([h.Class('nod-pulse'), h.AriaHidden(true)]), kind === 'Pay' ? 'Preparing the payment' : 'Declining'],
      ),
    ]),
    Match.tag('Failed', ({ kind, reason }) => [
      h.div(
        [h.Class('nod-fallback'), h.Role('alert')],
        [
          h.p([], [`${kind === 'Pay' ? 'Not paid' : 'Not declined'}: ${reason}`]),
          actions(
            [
              button('Try again', Message.ClickedConfirmRequestAction(), false, h),
              button('Cancel', Message.ClickedCancelRequestAction(), false, h),
              textLink('Open the request on Nod ↗', request.request_url, h),
            ],
            h,
          ),
        ],
      ),
    ]),
    Match.exhaustive,
  )
}

const incoming = (model: Model, request: RequestView, h: Builder): ReadonlyArray<Html> => {
  const [label, tone] = STATUS_LABEL[request.status]
  const who = otherParty(request)
  const isStranger = request.requester.contact_name === null
  return [
    eyebrow(request.status === 'open' ? 'Asks you for money' : label, request.status === 'open' ? 'quiet' : tone, h),
    headline(`${who} asks for`, h),
    amount(decimalUsdc(request.amount), h),
    h.p(
      [h.Class('nod-recipient')],
      ['from ', h.code([h.Class('nod-mono')], [shortAddress(request.requester.address)])],
    ),
    theirNote(request, h),
    facts([['Expires', time(request.expires_at, h)], ...receiptFact(request, h)], h),
    request.status === 'open' && isStranger
      ? note('They are not in your contacts, so paying always needs your nod with your passkey.', h)
      : h.empty,
    ...(request.status === 'open' ? incomingActions(model, request, h) : []),
    linkFallback(model.link, h),
  ]
}

const outgoing = (model: Model, request: RequestView, h: Builder): ReadonlyArray<Html> => {
  const [label, tone] = STATUS_LABEL[request.status]
  return [
    eyebrow(request.status === 'open' ? 'Waiting for them' : label, tone, h),
    headline(`You asked ${otherParty(request)} for`, h),
    amount(decimalUsdc(request.amount), h),
    theirNote(request, h),
    facts([['Expires', time(request.expires_at, h)], ...receiptFact(request, h)], h),
    request.status === 'open'
      ? note(
          request.payer_is_nod_wallet
            ? 'It is in their Nod inbox. They can also open the request link.'
            : 'They are not on Nod: send them the request link.',
          h,
        )
      : h.empty,
    request.status === 'open' ? actions([secondaryAction('Request link ↗', request.request_url, h)], h) : h.empty,
    linkFallback(model.link, h),
  ]
}

export const requestBody = (model: Model, request: RequestView, h: Builder): ReadonlyArray<Html> =>
  request.direction === 'incoming' ? incoming(model, request, h) : outgoing(model, request, h)

export const backButton = (label: string, message: Message, h: Builder): Html =>
  h.button([h.Type('button'), h.Class('nod-back'), h.OnClick(message)], [`← ${label}`])

export const requestView = (model: Model, request: RequestView, h: Builder): ReadonlyArray<Html> => [
  header(request.network, h),
  ...requestBody(model, request, h),
]

const requestRow = (request: RequestView, h: Builder): Html => {
  const [label] = STATUS_LABEL[request.status]
  const isActionable = request.direction === 'incoming' && request.status === 'open'
  return h.keyed('li')(
    request.request_id,
    [h.Class('nod-row')],
    [
      h.div(
        [h.Class('nod-row-main')],
        [
          h.span([h.Class('nod-row-amount')], [decimalUsdc(request.amount)]),
          h.span(
            [h.Class('nod-row-detail')],
            [`${request.direction === 'incoming' ? 'from' : 'to'} ${otherParty(request)} · ${label}`],
          ),
        ],
      ),
      isActionable
        ? h.button(
            [
              h.Type('button'),
              h.Class('nod-link'),
              h.OnClick(Message.ClickedReviewRequest({ requestId: request.request_id })),
            ],
            ['Review'],
          )
        : h.empty,
    ],
  )
}

export const requestRows = (title: string, requests: ReadonlyArray<RequestView>, empty: string, h: Builder): Html =>
  h.section(
    [h.Class('nod-panel')],
    [
      h.h2([h.Class('nod-label')], [title]),
      Array.match(requests, {
        onEmpty: () => h.p([h.Class('nod-empty')], [empty]),
        onNonEmpty: nonEmpty =>
          h.ul(
            [h.Class('nod-rows')],
            Array.map(nonEmpty, request => requestRow(request, h)),
          ),
      }),
    ],
  )

const DEFAULT_NETWORK = 'stellar:testnet'

export const requestsView = (model: Model, requests: ReadonlyArray<RequestView>, h: Builder): ReadonlyArray<Html> => {
  const selected = Option.flatMap(model.maybeSelectedRequestId, id =>
    Array.findFirst(requests, request => request.request_id === id),
  )
  return Option.match(selected, {
    onSome: request => [
      header(request.network, h),
      backButton('All requests', Message.ClickedAllRequests(), h),
      ...requestBody(model, request, h),
    ],
    onNone: () => {
      const incomingRequests = Array.filter(requests, request => request.direction === 'incoming')
      const outgoingRequests = Array.filter(requests, request => request.direction === 'outgoing')
      const waiting = Array.filter(incomingRequests, request => request.status === 'open').length
      return [
        header(
          Option.match(Array.head(requests), { onNone: () => DEFAULT_NETWORK, onSome: first => first.network }),
          h,
        ),
        eyebrow(waiting === 0 ? 'Payment requests' : `${waiting} waiting for you to pay`, 'quiet', h),
        requestRows('Asked of you', incomingRequests, 'Nobody has asked this wallet for money.', h),
        requestRows('You asked', outgoingRequests, 'This wallet has not asked anyone for money.', h),
        note('Notes are the requester’s words. Nod never pays a request on its own.', h),
      ]
    },
  })
}
