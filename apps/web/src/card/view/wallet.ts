import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type {
  ConnectionGrantCreateOutput as AllowanceLinkSchema,
  ConnectionGrantRevokeOutput as RevokeSchema,
  GrantView,
  PaymentView,
  ReceiptView,
  WalletOverviewOutput,
} from '@hm/protocol'

import { dateTime, decimalUsdc, shortAddress } from '../../format'
import type { Message } from '../message'
import type { Model } from '../model'
import {
  actions,
  allowanceMeter,
  amount,
  eyebrow,
  type Fact,
  facts,
  header,
  lead,
  linkFallback,
  note,
  pollStatus,
  primaryAction,
  textLink,
} from './parts'
import { requestRows } from './request'

/** `wallet_overview` and `nod_home` (the wallet), `connection_grant_create` and `connection_grant_revoke`. */

type Builder = HtmlBuilder<Message>
type AllowanceLink = typeof AllowanceLinkSchema.Type
type Revoke = typeof RevokeSchema.Type

/** The allowance and revoke results name no network; Nod runs on testnet. */
const DEFAULT_NETWORK = 'stellar:testnet'

const allowance = (clientName: string, grant: GrantView | null, h: Builder): Html => {
  if (grant === null) {
    return h.section(
      [h.Class('nod-panel')],
      [
        h.h2([h.Class('nod-label')], ['Allowance']),
        lead(`${clientName} has no allowance yet: every payment needs your nod.`, h),
      ],
    )
  }
  if (grant.status !== 'active') {
    return h.section(
      [h.Class('nod-panel')],
      [
        h.h2([h.Class('nod-label')], ['Allowance']),
        lead(`${clientName}'s allowance is ${grant.status}: every payment needs your nod.`, h),
      ],
    )
  }
  return h.section(
    [h.Class('nod-panel')],
    [
      h.h2([h.Class('nod-label')], ['Allowance left']),
      h.p(
        [h.Class('nod-allowance')],
        [h.strong([], [decimalUsdc(grant.remaining)]), ` of ${decimalUsdc(grant.total)}`],
      ),
      allowanceMeter(grant.remaining, grant.total, h),
      note(`${clientName} pays up to this on its own until ${dateTime(grant.valid_until)}.`, h),
    ],
  )
}

const pendingRow = (payment: PaymentView, h: Builder): Html =>
  h.keyed('li')(
    payment.payment_id,
    [h.Class('nod-row')],
    [
      h.div(
        [h.Class('nod-row-main')],
        [
          h.span([h.Class('nod-row-amount')], [decimalUsdc(payment.amount)]),
          h.span(
            [h.Class('nod-row-detail')],
            [`to ${payment.recipient.name ?? shortAddress(payment.recipient.address)}`],
          ),
        ],
      ),
      payment.approval_url === null ? h.empty : textLink('Approve ↗', payment.approval_url, h),
    ],
  )

const receiptRow = (receipt: ReceiptView, h: Builder): Html =>
  h.keyed('li')(
    receipt.receipt_id,
    [h.Class('nod-row')],
    [
      h.div(
        [h.Class('nod-row-main')],
        [
          h.span([h.Class('nod-row-amount')], [decimalUsdc(receipt.amount)]),
          h.span(
            [h.Class('nod-row-detail')],
            [`${receipt.recipient_name ?? shortAddress(receipt.recipient)} · ${dateTime(receipt.confirmed_at)}`],
          ),
        ],
      ),
      textLink(`${shortAddress(receipt.tx_hash)} ↗`, receipt.explorer_url, h),
    ],
  )

const list = <A>(
  title: string,
  items: ReadonlyArray<A>,
  row: (item: A, h: Builder) => Html,
  empty: string,
  h: Builder,
): Html =>
  h.section(
    [h.Class('nod-panel')],
    [
      h.h2([h.Class('nod-label')], [title]),
      Array.match(items, {
        onEmpty: () => h.p([h.Class('nod-empty')], [empty]),
        onNonEmpty: nonEmpty =>
          h.ul(
            [h.Class('nod-rows')],
            Array.map(nonEmpty, item => row(item, h)),
          ),
      }),
    ],
  )

const INLINE_RECEIPTS = 3
const HOME_RECEIPTS = 8

export const walletView = (model: Model, overview: WalletOverviewOutput, h: Builder): ReadonlyArray<Html> => {
  const isHome = model.surface === 'Home'
  const pending = overview.pending_approvals
  return [
    header(overview.wallet.network, h),
    Array.isReadonlyArrayNonEmpty(pending)
      ? eyebrow(
          pending.length === 1 ? '1 payment needs your nod' : `${pending.length} payments need your nod`,
          'nod',
          h,
        )
      : eyebrow(overview.wallet.name, 'quiet', h),
    amount(decimalUsdc(overview.balances.usdc), h),
    h.p(
      [h.Class('nod-recipient')],
      [`${overview.wallet.name} · `, h.code([h.Class('nod-mono')], [shortAddress(overview.wallet.contract_id)])],
    ),
    allowance(overview.connection.client_name, overview.grant, h),
    Array.isReadonlyArrayNonEmpty(pending) || isHome
      ? list('Needs your nod', pending, pendingRow, 'Nothing is waiting for you.', h)
      : h.empty,
    isHome
      ? requestRows(
          'Asks you for money',
          Array.filter(model.inbox, request => request.direction === 'incoming' && request.status === 'open'),
          'Nobody is asking you for money.',
          h,
        )
      : h.empty,
    list(
      'Recent payments',
      Array.take(overview.recent_receipts, isHome ? HOME_RECEIPTS : INLINE_RECEIPTS),
      receiptRow,
      'No payments yet.',
      h,
    ),
    linkFallback(model.link, h),
    isHome ? pollStatus(model, 'Live: refreshes every 10 seconds', h) : h.empty,
  ]
}

export const allowanceLinkView = (model: Model, link: AllowanceLink, h: Builder): ReadonlyArray<Html> => [
  header(DEFAULT_NETWORK, h),
  eyebrow('Allowance', 'quiet', h),
  link.grant === undefined || link.grant === null
    ? lead('No allowance yet: every payment needs your nod until you set one.', h)
    : h.div(
        [],
        [
          amount(decimalUsdc(link.grant.remaining), h),
          lead(`left of ${decimalUsdc(link.grant.total)} until ${dateTime(link.grant.valid_until)}.`, h),
          allowanceMeter(link.grant.remaining, link.grant.total, h),
        ],
      ),
  actions([primaryAction('Set the allowance with your passkey ↗', link.url, h)], h),
  linkFallback(model.link, h),
  note('You choose the amount and how long it lasts. Nod never raises it by itself.', h),
]

const revokeFacts = (revoke: Revoke, h: Builder): ReadonlyArray<Fact> => {
  const returned: ReadonlyArray<Fact> =
    revoke.sweep_tx === null ? [] : [['Returned', h.code([h.Class('nod-mono')], [shortAddress(revoke.sweep_tx)])]]
  const removed: ReadonlyArray<Fact> =
    revoke.removal_tx === undefined || revoke.removal_tx === null
      ? []
      : [['Removed', h.code([h.Class('nod-mono')], [shortAddress(revoke.removal_tx)])]]
  return [...returned, ...removed]
}

export const revokedView = (model: Model, revoke: Revoke, h: Builder): ReadonlyArray<Html> => [
  header(DEFAULT_NETWORK, h),
  eyebrow(
    revoke.onchain === 'removed' ? 'Revoked' : 'Revoked · one step left',
    revoke.onchain === 'removed' ? 'good' : 'nod',
    h,
  ),
  lead(
    revoke.onchain === 'removed'
      ? 'Nod stopped paying for this AI app and the allowance is gone from your Stellar account.'
      : 'Nod stopped paying for this AI app. Remove the allowance from your Stellar account with your passkey.',
    h,
  ),
  h.ul(
    [h.Class('nod-checklist')],
    [
      h.li([h.Class('nod-done')], ['Nod refuses to pay for this AI app']),
      h.li(
        [h.Class(revoke.sweep_tx === null ? '' : 'nod-done')],
        [revoke.sweep_tx === null ? 'No unspent USDC to return' : 'Unspent USDC returned to your wallet'],
      ),
      h.li(
        [h.Class(revoke.onchain === 'removed' ? 'nod-done' : 'nod-todo')],
        ['Allowance removed from your Stellar account'],
      ),
    ],
  ),
  facts(revokeFacts(revoke, h), h),
  revoke.approval_url === null
    ? h.empty
    : actions([primaryAction('Remove it with your passkey ↗', revoke.approval_url, h)], h),
  linkFallback(model.link, h),
]
