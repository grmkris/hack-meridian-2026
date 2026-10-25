import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { dateTime, decimalStroops, decimalUsdc, networkLabel, percentUsed, shortAddress } from '../../format'
import { Message } from '../message'
import type { LinkState, Model } from '../model'

/** The pieces every card view is built from. Class names are the card's own plain CSS (`card.css`). */

type Builder = HtmlBuilder<Message>

export type Tone = 'nod' | 'good' | 'bad' | 'quiet'

export const header = (network: string, h: Builder): Html =>
  h.header(
    [h.Class('nod-header')],
    [
      h.span([h.Class('nod-wordmark'), h.AriaLabel('Nod')], ['nod']),
      h.span([h.Class('nod-network')], [networkLabel(network)]),
    ],
  )

export const eyebrow = (text: string, tone: Tone, h: Builder): Html =>
  h.p([h.Class(`nod-eyebrow nod-tone-${tone}`)], [h.span([h.Class('nod-dot'), h.AriaHidden(true)]), text])

export const amount = (text: string, h: Builder): Html => h.p([h.Class('nod-amount')], [text])

export const headline = (text: string, h: Builder): Html => h.h1([h.Class('nod-headline')], [text])

export const lead = (text: string, h: Builder): Html => h.p([h.Class('nod-lead')], [text])

export const note = (text: string, h: Builder): Html => h.p([h.Class('nod-note')], [text])

export const mono = (text: string, h: Builder): Html => h.code([h.Class('nod-mono')], [text])

export type Fact = readonly [label: string, value: Html | string]

export const facts = (rows: ReadonlyArray<Fact>, h: Builder): Html =>
  Array.match(rows, {
    onEmpty: () => h.empty,
    onNonEmpty: nonEmpty =>
      h.dl(
        [h.Class('nod-facts')],
        Array.flatMap(nonEmpty, ([label, value]) => [h.dt([], [label]), h.dd([], [value])]),
      ),
  })

/** The recipient as a person reads them: a name and a short address, or the short address alone. */
export const recipientLine = (name: string | null, address: string, h: Builder): Html =>
  h.p(
    [h.Class('nod-recipient')],
    name === null
      ? [h.span([], ['to ']), mono(shortAddress(address), h)]
      : [
          h.span([], ['to ']),
          h.strong([], [name]),
          h.span([h.Class('nod-muted')], [' · ']),
          mono(shortAddress(address), h),
        ],
  )

export const primaryAction = (label: string, url: string, h: Builder): Html =>
  h.button(
    [h.Type('button'), h.Class('nod-button nod-button-primary'), h.OnClick(Message.ClickedOpenLink({ url }))],
    [label],
  )

export const secondaryAction = (label: string, url: string, h: Builder): Html =>
  h.button([h.Type('button'), h.Class('nod-button'), h.OnClick(Message.ClickedOpenLink({ url }))], [label])

export const textLink = (label: string, url: string, h: Builder): Html =>
  h.button([h.Type('button'), h.Class('nod-link'), h.OnClick(Message.ClickedOpenLink({ url }))], [label])

export const actions = (children: ReadonlyArray<Html>, h: Builder): Html => h.div([h.Class('nod-actions')], children)

/** When the chat would not open a link, the link itself, to copy. */
export const linkFallback = (link: LinkState, h: Builder): Html =>
  link._tag === 'Failed'
    ? h.div(
        [h.Class('nod-fallback'), h.Role('status')],
        [h.p([], [`${link.reason} Open this link yourself:`]), h.p([h.Class('nod-mono nod-select')], [link.url])],
      )
    : h.empty

/** Whether the chat lets the card call Nod's tools (and so watch a payment by itself). */
export const canWatch = (model: Model): boolean =>
  model.bridge._tag === 'Connecting' || (model.bridge._tag === 'Connected' && model.bridge.capabilities.canCallTools)

/** The live status line while the card polls; a still line saying who checks when this chat lets the card call nothing. */
export const pollStatus = (model: Model, text: string, h: Builder): Html => {
  if (!canWatch(model)) {
    return h.p(
      [h.Class('nod-status')],
      [
        h.span([h.Class('nod-pulse nod-pulse-still'), h.AriaHidden(true)]),
        `${text}. Ask the AI to check the payment afterwards.`,
      ],
    )
  }
  return h.p(
    [h.Class('nod-status'), h.AriaLive('polite')],
    Option.match(model.maybePollError, {
      onNone: () => [h.span([h.Class('nod-pulse'), h.AriaHidden(true)]), text],
      onSome: () => [h.span([h.Class('nod-pulse nod-pulse-still'), h.AriaHidden(true)]), `${text} (retrying)`],
    }),
  )
}

/** The AI app as the card can name it: the chat's own name, or "This AI app". */
export const appName = (model: Model): Option.Option<string> => model.maybeAppName

/** "Allowance left: 2.90 USDC", and under it who pays up to that on its own. */
export const allowanceLeft = (model: Model, remaining: string, h: Builder): Fact => [
  'Allowance left',
  h.span(
    [h.Class('nod-stack')],
    [
      h.span([], [decimalUsdc(remaining)]),
      h.small(
        [h.Class('nod-small')],
        [`${Option.getOrElse(appName(model), () => 'This AI app')} pays up to this on its own`],
      ),
    ],
  ),
]

/** Text a person might want but not read first (a facilitator's or Stellar's own words), folded away. */
export const details = (summary: string, text: string, h: Builder): Html =>
  h.details([h.Class('nod-details')], [h.summary([], [summary]), h.p([], [text])])

export const time = (iso: string, h: Builder): Html => h.time([h.Attribute('datetime', iso)], [dateTime(iso)])

/** How much of the allowance is left, as a meter. */
export const allowanceMeter = (remaining: string, total: string, h: Builder): Html => {
  const used = Option.match(Option.all([decimalStroops(total), decimalStroops(remaining)]), {
    onNone: () => 0,
    onSome: ([whole, left]) => percentUsed(whole, left),
  })
  return h.div(
    [
      h.Class('nod-meter'),
      h.Role('meter'),
      h.Attribute('aria-valuemin', '0'),
      h.Attribute('aria-valuemax', '100'),
      h.Attribute('aria-valuenow', String(100 - used)),
      h.AriaLabel('Allowance left'),
    ],
    [h.div([h.Class('nod-meter-fill'), h.Style({ width: `${100 - used}%` })])],
  )
}
