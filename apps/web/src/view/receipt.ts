import { Match, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { ReceiptRecord } from '@hm/protocol'

import { dateTime, shortAddress, usdc, xlm } from '../format'
import { LINK, badge } from './ui'

const title = (receipt: ReceiptRecord): string =>
  Match.value(receipt.kind).pipe(
    Match.withReturnType<string>(),
    Match.when('payment', () => `Paid ${receipt.recipient_name ?? shortAddress(receipt.recipient_address)}`),
    Match.when('x402_fetch', () => 'Bought a paid resource'),
    Match.when('x402_mcp', () => 'Paid for an MCP tool call'),
    Match.exhaustive,
  )

const feeLine = (receipt: ReceiptRecord): string =>
  receipt.fee_paid_by === 'relayer'
    ? `Fee ${xlm(receipt.fee_stroops)} paid by the wallet service`
    : `Fee paid by the facilitator (${receipt.fee_payer})`

const laneBadge = <Message>(receipt: ReceiptRecord, h: HtmlBuilder<Message>): Html =>
  receipt.lane === 'autonomous' ? badge('Within allowance', 'accent', h) : badge('Approved with passkey', 'good', h)

const explorerLinks = <Message>(receipt: ReceiptRecord, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.a([h.Href(receipt.explorer_url), h.Target('_blank'), h.Rel('noreferrer'), h.Class(LINK)], ['Transaction']),
  ...Option.match(Option.fromNullishOr(receipt.pull_explorer_url), {
    onNone: () => [],
    onSome: url => [h.a([h.Href(url), h.Target('_blank'), h.Rel('noreferrer'), h.Class(LINK)], ['Allowance pull'])],
  }),
]

export const receiptRow = <Message>(receipt: ReceiptRecord, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    receipt.id,
    [h.Class('flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6')],
    [
      h.div(
        [h.Class('flex min-w-0 flex-col gap-1')],
        [
          h.div(
            [h.Class('flex flex-wrap items-center gap-2')],
            [h.span([h.Class('font-semibold text-ink')], [title(receipt)]), laneBadge(receipt, h)],
          ),
          h.p(
            [h.Class('text-sm text-muted')],
            [`${receipt.requester} · ${dateTime(receipt.confirmed_at)} · ${feeLine(receipt)}`],
          ),
          ...Option.match(Option.fromNullishOr(receipt.resource), {
            onNone: () => [],
            onSome: resource => [h.p([h.Class('truncate font-mono text-xs text-muted')], [resource])],
          }),
          h.div([h.Class('flex flex-wrap gap-4 text-sm')], explorerLinks(receipt, h)),
        ],
      ),
      h.p([h.Class('shrink-0 text-lg font-semibold tabular-nums text-ink')], [`−${usdc(receipt.amount)}`]),
    ],
  )
