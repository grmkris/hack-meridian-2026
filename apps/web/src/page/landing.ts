import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  CLAIM,
  DAWN,
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

// The signed-out home as one story: a night over Lisbon behind the hero (landing.css), where the example wallet waits
// for the visitor's nod; then the chapters on paper, each beside its own plate of the same swallow; then the same
// rooftops at dawn. Words come from landing-copy.ts.

type Plate = 'hand' | 'seal' | 'door' | 'ledger' | 'flight'

type Side = 'start' | 'end'

// ICONS (Lucide, ISC)

const fingerprintPaths: ReadonlyArray<string> = [
  'M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4',
  'M14 13.12c0 2.38 0 6.38-1 8.88',
  'M17.29 21.02c.12-.6.43-2.3.5-3.02',
  'M2 12a10 10 0 0 1 18-6',
  'M2 16h.01',
  'M21.8 16c.2-2 .131-5.354 0-6',
  'M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2',
  'M8.65 22c.21-.66.45-1.32.57-2',
  'M9 6.8a6 6 0 0 1 9 5.2v2',
]

const icon = <Message>(paths: ReadonlyArray<string>, h: HtmlBuilder<Message>): Html =>
  h.svg(
    [
      h.ViewBox('0 0 24 24'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('2'),
      h.StrokeLinecap('round'),
      h.StrokeLinejoin('round'),
      h.AriaHidden(true),
    ],
    Array.map(paths, d => h.path([h.D(d)])),
  )

// HERO

const sceneView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-hero-art'), h.AriaHidden(true)],
    [h.div([h.Class('landing-scene')], [h.div([h.Class('landing-etching')]), h.div([h.Class('landing-glow')])])],
  )

const barView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('landing-bar landing-width')],
    [
      h.p([h.Class('landing-wordmark')], [HERO.wordmark]),
      h.span([h.Class('landing-network')], [HERO.network]),
      h.a(
        [h.Href(REPOSITORY_URL), h.Target('_blank'), h.Rel('noreferrer'), h.Class('landing-bar-link')],
        [FOOTER.source],
      ),
    ],
  )

const [figureStart, figureMiddle, figureEnd] = EXAMPLE_WALLET.allowanceFigures

const allowanceView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('nod-head')],
    [
      h.div(
        [],
        [
          h.p([h.Class('nod-label')], [EXAMPLE_WALLET.allowanceLabel]),
          h.p(
            [h.Class('nod-allowance')],
            [
              h.span(
                [h.Class('nod-figures')],
                [
                  h.span(
                    [h.Class('nod-figure-was'), h.DataAttribute('figure', '0'), h.AriaHidden(true)],
                    [figureStart],
                  ),
                  h.span(
                    [h.Class('nod-figure-was'), h.DataAttribute('figure', '1'), h.AriaHidden(true)],
                    [figureMiddle],
                  ),
                  h.span([h.Class('nod-figure-now')], [figureEnd]),
                ],
              ),
              h.span([h.Class('nod-allowance-unit')], [EXAMPLE_WALLET.unit]),
            ],
          ),
        ],
      ),
      h.p([h.Class('nod-wallet')], [EXAMPLE_WALLET.balanceLabel, h.strong([], [EXAMPLE_WALLET.balance])]),
      h.p([h.Class('nod-until')], [EXAMPLE_WALLET.allowanceLine]),
    ],
  )

const meterView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('meter'),
      h.AriaLabel(EXAMPLE_WALLET.allowanceMeterLabel),
      h.AriaValuenow(58),
      h.AriaValuemin(0),
      h.AriaValuemax(100),
      h.Class('nod-meter'),
    ],
    [h.div([h.Class('nod-meter-fill')])],
  )

type Payment = (typeof EXAMPLE_WALLET.payments)[number]

/** The hero's example wallet: what welcome.ts tells it (asking or approved, which run) and the two Messages it sends. */
export type Example<Message> = Readonly<{ approved: boolean; run: number; approve: Message; replay: Message }>

const paymentView = <Message>(payment: Payment, approved: boolean, h: HtmlBuilder<Message>): Html => {
  const asked = payment.id === 'bob'
  return h.keyed('li')(
    payment.id,
    [h.Class(asked ? 'nod-row nod-row-asked' : 'nod-row'), h.DataAttribute('step', payment.id)],
    [
      h.span([h.Class('nod-who')], [payment.who, h.span([h.Class('nod-why')], [payment.why])]),
      h.span([h.Class('nod-amount')], [payment.amount]),
      h.span(
        [h.Class('nod-state')],
        [
          asked && !approved
            ? h.span([h.Class('nod-asked')], [EXAMPLE_WALLET.askBadge])
            : h.span([h.Class('nod-paid')], [payment.paid]),
        ],
      ),
    ],
  )
}

/** Asking: the visitor's own Approve button, with the note that it is an example. Approved: the outcome and a replay. */
const approvalView = <Message>(example: Example<Message>, h: HtmlBuilder<Message>): Html =>
  example.approved
    ? h.div(
        [h.Class('nod-approval'), h.DataAttribute('nod', 'approved')],
        [
          h.p([h.Class('nod-approved'), h.Role('status')], [icon(fingerprintPaths, h), EXAMPLE_WALLET.approved]),
          h.button(
            [
              h.Type('button'),
              h.Class('nod-replay'),
              h.DataAttribute('testid', 'example-replay'),
              h.OnClick(example.replay),
            ],
            [EXAMPLE_WALLET.replay],
          ),
        ],
      )
    : h.div(
        [h.Class('nod-approval'), h.DataAttribute('nod', 'asking')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('nod-approve'),
              h.DataAttribute('testid', 'example-approve'),
              h.AriaDescribedBy('nod-try-note'),
              h.OnClick(example.approve),
            ],
            [icon(fingerprintPaths, h), EXAMPLE_WALLET.approve],
          ),
          h.p([h.Id('nod-try-note'), h.Class('nod-try-note')], [EXAMPLE_WALLET.tryNote]),
        ],
      )

const exampleWalletView = <Message>(example: Example<Message>, h: HtmlBuilder<Message>): Html =>
  h.keyed('figure')(
    `example-${example.run}`,
    [
      h.Class('nod-card'),
      h.DataAttribute('nod', example.approved ? 'approved' : 'asking'),
      h.AriaLabel(EXAMPLE_WALLET.label),
    ],
    [
      allowanceView(h),
      meterView(h),
      h.ol(
        [h.Class('nod-feed')],
        Array.map(EXAMPLE_WALLET.payments, payment => paymentView(payment, example.approved, h)),
      ),
      approvalView(example, h),
      h.figcaption([h.Class('nod-caption')], [EXAMPLE_WALLET.caption]),
    ],
  )

type Slots<Message> = Readonly<{ walletForm: Html; addToClaude: Html; connectorUrl: string; example: Example<Message> }>

const heroView = <Message>(slots: Slots<Message>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class('landing-hero'),
      h.DataAttribute('scene', 'night'),
      h.DataAttribute('nod', slots.example.approved ? 'approved' : 'asking'),
      h.AriaLabelledBy('landing-title'),
    ],
    [
      barView(h),
      sceneView(h),
      h.div(
        [h.Class('landing-hero-grid landing-width')],
        [
          h.div(
            [h.Class('landing-hero-copy')],
            [
              h.h1([h.Id('landing-title'), h.Class('landing-title')], [HERO.title]),
              h.p([h.Class('landing-lede')], [HERO.lede]),
              h.div([h.Class('landing-actions')], [slots.walletForm, slots.addToClaude]),
            ],
          ),
          exampleWalletView(slots.example, h),
        ],
      ),
    ],
  )

// CHAPTERS

const plateView = <Message>(plate: Plate, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('landing-plate landing-etching'), h.DataAttribute('plate', plate), h.AriaHidden(true)])

const headingView = <Message>(id: string, title: string, lead: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('landing-heading')], [h.h2([h.Id(id)], [title]), h.p([], [lead])])

/** A chapter: its plate on one side, its words on the other; the sides alternate down the page. */
const chapterView = <Message>(
  id: string,
  plate: Plate,
  side: Side,
  body: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('landing-chapter landing-width'), h.DataAttribute('side', side), h.AriaLabelledBy(id)],
    [plateView(plate, h), h.div([h.Class('landing-chapter-body')], body)],
  )

const stepView = <Message>(step: Point, position: number, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    step.id,
    [h.Class('landing-step')],
    [
      h.span([h.Class('landing-step-number')], [`${position}`]),
      h.span([h.Class('landing-step-title')], [step.title]),
      h.span([h.Class('landing-step-body')], [step.body]),
    ],
  )

const howItWorksView = <Message>(h: HtmlBuilder<Message>): Html =>
  chapterView(
    'how-it-works',
    'hand',
    'start',
    [
      headingView('how-it-works', HOW_IT_WORKS.title, HOW_IT_WORKS.lead, h),
      h.ol(
        [h.Class('landing-steps')],
        Array.map(HOW_IT_WORKS.steps, (step, index) => stepView(step, index + 1, h)),
      ),
    ],
    h,
  )

const pointView = <Message>(point: Point, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    point.id,
    [h.Class('landing-point')],
    [h.span([h.Class('landing-point-title')], [point.title]), h.span([h.Class('landing-point-body')], [point.body])],
  )

const trustView = <Message>(h: HtmlBuilder<Message>): Html =>
  chapterView(
    'trust',
    'seal',
    'end',
    [
      headingView('trust', TRUST.title, TRUST.lead, h),
      h.ul(
        [h.Class('landing-points')],
        Array.map(TRUST.points, point => pointView(point, h)),
      ),
    ],
    h,
  )

const claimView = <Message>(h: HtmlBuilder<Message>): Html =>
  chapterView(
    'claim',
    'door',
    'start',
    [
      h.div(
        [h.Class('landing-heading')],
        [h.h2([h.Id('claim')], [CLAIM.title]), h.span([h.Class('landing-tag')], [CLAIM.badge])],
      ),
      h.p([h.Class('landing-claim-body')], [CLAIM.body]),
    ],
    h,
  )

const proofRowView = <Message>(proof: Proof, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    proof.hash,
    [h.Class('landing-ledger-row')],
    [
      h.span([h.Class('landing-ledger-claim')], [proof.claim]),
      h.a(
        [
          h.Href(`${EXPLORER_TX_URL}${proof.hash}`),
          h.Target('_blank'),
          h.Rel('noreferrer'),
          h.Class('landing-ledger-tx'),
        ],
        [proof.hash.slice(0, 8)],
      ),
    ],
  )

const proofView = <Message>(h: HtmlBuilder<Message>): Html =>
  chapterView(
    'proof',
    'ledger',
    'end',
    [
      headingView('proof', PROOF.title, PROOF.lead, h),
      h.ul(
        [h.Class('landing-ledger')],
        Array.map(PROOF.items, proof => proofRowView(proof, h)),
      ),
    ],
    h,
  )

const tryItView = <Message>(connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  chapterView(
    'try-it',
    'flight',
    'start',
    [
      headingView('try-it', TRY_IT.title, TRY_IT.lead, h),
      h.ol(
        [h.Class('landing-try')],
        [
          h.li([], [TRY_IT.connectorStep, h.code([], [connectorUrl])]),
          ...Array.map(TRY_IT.steps, step => h.li([], [step])),
        ],
      ),
      h.div(
        [h.Class('landing-sample')],
        [
          h.p([], [TRY_IT.sampleLead, h.a([h.Href(TRY_IT.sampleHref)], [TRY_IT.sample])]),
          h.p([h.Class('landing-sample-note')], [TRY_IT.sampleNote]),
        ],
      ),
    ],
    h,
  )

/** The same rooftops at dawn, the swallow out again: the night's ask, answered. */
const dawnView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-dawn')],
    [
      h.p([h.Class('landing-dawn-line landing-width')], [DAWN.line]),
      h.div(
        [h.Class('landing-dawn-scene'), h.AriaHidden(true)],
        [h.div([h.Class('landing-etching')]), h.div([h.Class('landing-dawn-sun')])],
      ),
    ],
  )

const footerView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class('landing-footer landing-width')],
    [
      h.ul(
        [h.Class('landing-built')],
        Array.map(FOOTER.builtWith, name => h.keyed('li')(name, [], [name])),
      ),
      h.p([], [FOOTER.note, h.a([h.Href(REPOSITORY_URL), h.Target('_blank'), h.Rel('noreferrer')], [FOOTER.source])]),
    ],
  )

export const view = <Message>(slots: Slots<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing')],
    [
      heroView(slots, h),
      h.div(
        [h.Class('landing-page')],
        [
          howItWorksView(h),
          trustView(h),
          claimView(h),
          proofView(h),
          tryItView(slots.connectorUrl, h),
          dawnView(h),
          footerView(h),
        ],
      ),
    ],
  )
