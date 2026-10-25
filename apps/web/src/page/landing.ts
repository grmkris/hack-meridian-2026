import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { LINK, badge, meter } from '../view/ui'
import {
  CLAIM,
  EXAMPLE_WALLET,
  EXPLORER_TX_URL,
  FOOTER,
  HERO,
  HOW_IT_WORKS,
  PROOF,
  type Point,
  type Proof,
  REPOSITORY_URL,
  TRUST,
  TRY_IT,
} from './landing-copy'

// VIEW

const sectionHeading = <Message>(title: string, lead: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex max-w-2xl flex-col gap-2')],
    [
      h.h2([h.Class('text-2xl font-semibold tracking-tight text-balance text-ink sm:text-3xl')], [title]),
      h.p([h.Class('text-base text-pretty text-muted')], [lead]),
    ],
  )

const allowanceCard = <Message>(h: HtmlBuilder<Message>): Html =>
  h.figure(
    [h.Class('flex w-full flex-col gap-3')],
    [
      h.div(
        [h.Class('grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2')],
        [
          h.div(
            [h.Class('flex flex-col gap-2 bg-paper p-5')],
            [
              h.p(
                [h.Class('text-xs font-semibold uppercase tracking-[0.14em] text-muted')],
                [EXAMPLE_WALLET.balanceLabel],
              ),
              h.p([h.Class('text-3xl font-semibold tracking-tight tabular-nums text-ink')], [EXAMPLE_WALLET.balance]),
              h.p([h.Class('text-sm text-muted')], [EXAMPLE_WALLET.walletLine]),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-2 bg-paper p-5')],
            [
              h.p(
                [h.Class('text-xs font-semibold uppercase tracking-[0.14em] text-muted')],
                [EXAMPLE_WALLET.allowanceLabel],
              ),
              h.p(
                [h.Class('text-3xl font-semibold tracking-tight tabular-nums text-accent')],
                [EXAMPLE_WALLET.allowance],
              ),
              meter(0, EXAMPLE_WALLET.allowanceMeterLabel, h),
              h.p([h.Class('text-sm text-muted')], [EXAMPLE_WALLET.allowanceLine]),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-2 bg-paper p-5 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between')],
            [
              h.div(
                [h.Class('flex flex-col gap-1')],
                [
                  h.p([h.Class('font-semibold tabular-nums text-ink')], [EXAMPLE_WALLET.askAmount]),
                  h.p([h.Class('text-sm text-muted')], [EXAMPLE_WALLET.askLine]),
                ],
              ),
              badge(EXAMPLE_WALLET.askBadge, 'warn', h),
            ],
          ),
        ],
      ),
      h.figcaption([h.Class('text-sm text-muted')], [EXAMPLE_WALLET.caption]),
    ],
  )

const heroView = <Message>(slots: Readonly<{ walletForm: Html; addToClaude: Html }>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-x-16')],
    [
      h.div(
        [h.Class('flex min-w-0 flex-col gap-5')],
        [
          h.div(
            [h.Class('flex flex-wrap items-center gap-3')],
            [
              h.p([h.Class('text-sm font-semibold tracking-tight text-accent')], [HERO.wordmark]),
              badge(HERO.network, 'quiet', h),
            ],
          ),
          h.h1([h.Class('text-4xl font-semibold tracking-tight text-balance text-ink sm:text-5xl')], [HERO.title]),
          h.p([h.Class('max-w-xl text-lg text-pretty text-muted')], [HERO.lede]),
        ],
      ),
      h.div(
        [h.Class('flex min-w-0 flex-col items-stretch gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1')],
        [slots.walletForm, slots.addToClaude],
      ),
      h.div([h.Class('min-w-0 lg:col-start-1 lg:row-start-2')], [allowanceCard(h)]),
    ],
  )

const stepItem = <Message>(step: Point, position: number, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    step.id,
    [h.Class('flex flex-col gap-2 border-t border-line pt-4')],
    [
      h.span([h.Class('text-sm font-semibold tabular-nums text-accent')], [`${position}`]),
      h.span([h.Class('text-lg font-semibold text-ink')], [step.title]),
      h.span([h.Class('text-sm text-pretty text-muted')], [step.body]),
    ],
  )

const howItWorksView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-6')],
    [
      sectionHeading(HOW_IT_WORKS.title, HOW_IT_WORKS.lead, h),
      h.ol(
        [h.Class('grid gap-6 sm:grid-cols-3')],
        Array.map(HOW_IT_WORKS.steps, (step, index) => stepItem(step, index + 1, h)),
      ),
    ],
  )

const trustItem = <Message>(point: Point, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    point.id,
    [h.Class('flex flex-col gap-1')],
    [
      h.span([h.Class('font-semibold text-ink')], [point.title]),
      h.span([h.Class('text-sm text-pretty text-muted')], [point.body]),
    ],
  )

const trustView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-6')],
    [
      sectionHeading(TRUST.title, TRUST.lead, h),
      h.ul(
        [h.Class('grid gap-6 sm:grid-cols-2')],
        Array.map(TRUST.points, point => trustItem(point, h)),
      ),
    ],
  )

const claimView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-4 rounded-3xl border border-line bg-paper p-6 sm:p-8')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center gap-3')],
        [
          h.h2([h.Class('text-2xl font-semibold tracking-tight text-balance text-ink')], [CLAIM.title]),
          badge(CLAIM.badge, 'warn', h),
        ],
      ),
      h.p([h.Class('max-w-2xl text-base text-pretty text-muted')], [CLAIM.body]),
    ],
  )

const proofItem = <Message>(proof: Proof, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    proof.hash,
    [
      h.Class(
        'flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6',
      ),
    ],
    [
      h.span([h.Class('min-w-0 text-sm text-pretty text-ink')], [proof.claim]),
      h.a(
        [
          h.Href(`${EXPLORER_TX_URL}${proof.hash}`),
          h.Target('_blank'),
          h.Rel('noreferrer'),
          h.Class(`${LINK} shrink-0 font-mono text-sm`),
        ],
        [proof.hash.slice(0, 8)],
      ),
    ],
  )

const proofView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-6')],
    [
      sectionHeading(PROOF.title, PROOF.lead, h),
      h.ul(
        [h.Class('divide-y divide-line rounded-3xl border border-line bg-paper p-5 sm:p-6')],
        Array.map(PROOF.items, proof => proofItem(proof, h)),
      ),
    ],
  )

const tryItView = <Message>(connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-6')],
    [
      sectionHeading(TRY_IT.title, TRY_IT.lead, h),
      h.ol(
        [h.Class('flex max-w-2xl list-decimal flex-col gap-3 pl-5 text-base text-pretty text-ink marker:text-muted')],
        [
          h.li(
            [],
            [
              TRY_IT.connectorStep,
              h.code([h.Class('select-all break-all font-mono text-sm text-ink')], [connectorUrl]),
            ],
          ),
          ...Array.map(TRY_IT.steps, step => h.li([], [step])),
        ],
      ),
    ],
  )

const builtWithItem = <Message>(name: string, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(name, [h.Class('rounded-full bg-mist px-3 py-1 text-sm text-ink')], [name])

const footerView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class('flex flex-col gap-4 border-t border-line pt-8')],
    [
      h.ul(
        [h.Class('flex flex-wrap gap-2')],
        Array.map(FOOTER.builtWith, name => builtWithItem(name, h)),
      ),
      h.p(
        [h.Class('max-w-2xl text-sm text-pretty text-muted')],
        [
          FOOTER.note,
          h.a([h.Href(REPOSITORY_URL), h.Target('_blank'), h.Rel('noreferrer'), h.Class(LINK)], [FOOTER.source]),
        ],
      ),
    ],
  )

export const view = <Message>(
  slots: Readonly<{ walletForm: Html; addToClaude: Html; connectorUrl: string }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('mx-auto flex max-w-5xl flex-col gap-16 px-4 py-12 sm:gap-20 sm:py-16')],
    [
      heroView(slots, h),
      howItWorksView(h),
      trustView(h),
      claimView(h),
      proofView(h),
      tryItView(slots.connectorUrl, h),
      footerView(h),
    ],
  )
