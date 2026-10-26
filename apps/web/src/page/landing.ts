import { Array } from 'effect'
import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'

import {
  CLAIM,
  DAWN,
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

// The signed-out home: a night over Lisbon, one wallet entry, chapters on paper, and rooftops at dawn.

type Plate = 'hand' | 'seal' | 'door' | 'ledger' | 'flight'

/** A six-second loop with its transition baked into the asset by scripts/landing-loop.ts. */
export const NIGHT_FLIGHT_SRC = '/landing/night-flight-loop.mp4'

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

// HERO

const sceneView = <Message>(nightFlight: Attribute<Message>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('landing-hero-art'), h.AriaHidden(true)],
    [
      h.div(
        [h.Class('landing-scene')],
        [
          h.div([h.Class('landing-etching')]),
          h.video([
            h.Id('landing-night-flight'),
            h.Class('landing-scene-video'),
            h.Muted(true),
            h.Playsinline(true),
            h.Loop(true),
            h.Preload('none'),
            nightFlight,
          ]),
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

type Slots<Message> = Readonly<{
  walletForm: Html
  addToClaude: Html
  connectorUrl: string
  nightFlight: Attribute<Message>
  motionControl: Html
}>

const heroView = <Message>(slots: Slots<Message>, network: NetworkKind, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('landing-hero'), h.DataAttribute('scene', 'night'), h.AriaLabelledBy('landing-title')],
    [
      barView(network, h),
      sceneView(slots.nightFlight, h),
      slots.motionControl,
      h.div(
        [h.Class('landing-hero-grid landing-width')],
        [
          h.div(
            [h.Class('landing-hero-copy')],
            [
              h.h1([h.Id('landing-title'), h.Class('landing-title')], [HERO.title]),
              h.p([h.Class('landing-lede')], [HERO.lede]),
              h.div([h.Class('landing-actions')], [slots.walletForm]),
            ],
          ),
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

const howItWorksView = <Message>(addToClaude: Html, h: HtmlBuilder<Message>): Html =>
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
      addToClaude,
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
          howItWorksView(slots.addToClaude, h),
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
