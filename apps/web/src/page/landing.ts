import { Array } from 'effect'
import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'

import {
  CLAIM,
  DAWN,
  EXAMPLE_WALLET,
  EXPLORER_TX_URL,
  FOOTER,
  HERO,
  HOW_IT_WORKS,
  NETWORK_COPY,
  type NetworkKind,
  PROOF,
  type Point,
  type Proof,
  REPOSITORY_URL,
  SANDBOX_ORIGIN,
  TRUST,
  TRY_IT,
  WHY,
} from './landing-copy'

// The signed-out home as one story: a night over Lisbon behind the hero (landing.css), where the example wallet waits
// for the visitor's nod; then the chapters on paper, each beside its own plate of the same swallow; then the same
// rooftops at dawn. Words come from landing-copy.ts.

type Plate = 'hand' | 'seal' | 'door' | 'ledger' | 'flight'

/** The night scene as a moving etching, played once by welcome.ts's PlayNightFlight. */
export const NIGHT_FLIGHT_SRC = '/landing/night-flight.mp4'

type Side = 'start' | 'end'

/**
 * The same page is served by the sandbox (testnet.trynod.si, and localhost in development) and by the product on
 * mainnet (trynod.si). The host in the connector URL, which comes from the page's own origin, picks the few words that
 * differ (landing-copy.ts NETWORK_COPY).
 */
export const networkOf = (connectorUrl: string): NetworkKind => {
  const host = /^[a-z]+:\/\/([^/:]+)/u.exec(connectorUrl)?.[1] ?? ''
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('testnet.') || host.includes('-testnet')
    ? 'testnet'
    : 'mainnet'
}

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

const sceneView = <Message>(nightFlight: Attribute<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-hero-art'), h.AriaHidden(true)],
    [
      h.div(
        [h.Class('landing-scene')],
        [
          h.div([h.Class('landing-etching')]),
          h.video([h.Class('landing-scene-video'), h.Muted(true), h.Playsinline(true), h.Preload('none'), nightFlight]),
          h.div([h.Class('landing-glow')]),
        ],
      ),
    ],
  )

const barView = <Message>(network: NetworkKind, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('landing-bar landing-width')],
    [
      h.p([h.Class('landing-wordmark')], [HERO.wordmark]),
      h.span([h.Class('landing-network')], [NETWORK_COPY[network].badge]),
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

/**
 * Both states stay rendered, each pair in one grid cell (landing.css), so the visitor's Approve gives way to the outcome
 * as one change and the card never changes height. The hidden half is disabled and out of the accessibility tree; the
 * status line is empty until the nod, so a screen reader hears the outcome when it arrives.
 */
const approvalView = <Message>(example: Example<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('nod-approval'), h.DataAttribute('nod', example.approved ? 'approved' : 'asking')],
    [
      h.div(
        [h.Class('nod-approval-stack')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('nod-approve'),
              h.DataAttribute('testid', 'example-approve'),
              h.AriaDescribedBy('nod-try-note'),
              h.Disabled(example.approved),
              h.OnClick(example.approve),
            ],
            [icon(fingerprintPaths, h), EXAMPLE_WALLET.approve],
          ),
          h.p(
            [h.Class('nod-approved'), h.Role('status')],
            example.approved ? [icon(fingerprintPaths, h), EXAMPLE_WALLET.approved] : [],
          ),
        ],
      ),
      h.div(
        [h.Class('nod-approval-foot')],
        [
          h.p([h.Id('nod-try-note'), h.Class('nod-try-note')], [EXAMPLE_WALLET.tryNote]),
          h.button(
            [
              h.Type('button'),
              h.Class('nod-replay'),
              h.DataAttribute('testid', 'example-replay'),
              h.Disabled(!example.approved),
              h.OnClick(example.replay),
            ],
            [EXAMPLE_WALLET.replay],
          ),
        ],
      ),
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

type Slots<Message> = Readonly<{
  walletForm: Html
  addToClaude: Html
  connectorUrl: string
  nightFlight: Attribute<Message>
  example: Example<Message>
}>

const heroView = <Message>(slots: Slots<Message>, network: NetworkKind, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class('landing-hero'),
      h.DataAttribute('scene', 'night'),
      h.DataAttribute('nod', slots.example.approved ? 'approved' : 'asking'),
      h.AriaLabelledBy('landing-title'),
    ],
    [
      barView(network, h),
      sceneView(slots.nightFlight, h),
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

/** Why a wallet belongs in the chat, before how this one works: the trust chapter's points, beside the swallow. */
const whyView = <Message>(h: HtmlBuilder<Message>): Html =>
  chapterView(
    'why',
    'flight',
    'end',
    [
      headingView('why', WHY.title, WHY.lead, h),
      h.ul(
        [h.Class('landing-points')],
        Array.map(WHY.points, point => pointView(point, h)),
      ),
    ],
    h,
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
          h.Href(`${proof.explorer ?? EXPLORER_TX_URL}${proof.hash}`),
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

/** Every step works on the sandbox, so on mainnet the block sends the visitor there (its connector, its sample). */
const tryItView = <Message>(network: NetworkKind, connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  chapterView(
    'try-it',
    'flight',
    'start',
    [
      headingView('try-it', TRY_IT.title, NETWORK_COPY[network].tryLead, h),
      h.ol(
        [h.Class('landing-try')],
        [
          h.li(
            [],
            [TRY_IT.connectorStep, h.code([], [network === 'mainnet' ? `${SANDBOX_ORIGIN}/mcp` : connectorUrl])],
          ),
          ...Array.map(TRY_IT.steps, step => h.li([], [step])),
        ],
      ),
      h.div(
        [h.Class('landing-sample')],
        [
          h.p([], [TRY_IT.sampleLead, h.a([h.Href(TRY_IT.sampleHref[network])], [TRY_IT.sample])]),
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

const footerView = <Message>(network: NetworkKind, h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class('landing-footer landing-width')],
    [
      h.ul(
        [h.Class('landing-built')],
        Array.map(FOOTER.builtWith, name => h.keyed('li')(name, [], [name])),
      ),
      h.p(
        [],
        [
          NETWORK_COPY[network].footerNote,
          h.a([h.Href(REPOSITORY_URL), h.Target('_blank'), h.Rel('noreferrer')], [FOOTER.source]),
        ],
      ),
    ],
  )

export const view = <Message>(slots: Slots<Message>, h: HtmlBuilder<Message>): Html => {
  const network = networkOf(slots.connectorUrl)
  return h.div(
    [h.Class('landing')],
    [
      heroView(slots, network, h),
      h.div(
        [h.Class('landing-page')],
        [
          whyView(h),
          howItWorksView(h),
          trustView(h),
          claimView(h),
          proofView(h),
          tryItView(network, slots.connectorUrl, h),
          dawnView(h),
          footerView(network, h),
        ],
      ),
    ],
  )
}
