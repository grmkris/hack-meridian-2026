import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { LINK, badge, meter } from '../view/ui'

// CONTENT

type Point = Readonly<{ id: string; title: string; body: string }>

type Proof = Readonly<{ hash: string; claim: string }>

const REPOSITORY_URL = 'https://github.com/grmkris/hack-meridian-2026'

const EXPLORER_TX_URL = 'https://stellar.expert/explorer/testnet/tx/'

const STEPS: ReadonlyArray<Point> = [
  {
    id: 'connect',
    title: 'Connect',
    body: 'Add Nod to Claude, or any MCP app, with one connector URL.',
  },
  {
    id: 'allowance',
    title: 'Set an allowance',
    body: '“5 USDC until tomorrow.” Your passkey signs it, and it is written to your Stellar account.',
  },
  {
    id: 'pay',
    title: 'Let it pay',
    body: 'Paid APIs over x402 and friends by name, inside the allowance. Bigger asks come to your phone.',
  },
]

const TRUST: ReadonlyArray<Point> = [
  {
    id: 'onchain',
    title: 'The limit lives on Stellar, not on our server',
    body: 'An OpenZeppelin spending-limit policy on your account caps each AI app. Even our service cannot spend more than you allowed.',
  },
  {
    id: 'exact',
    title: 'Your passkey approves the exact payment',
    body: 'The link shows the recipient’s name and address, the amount and which AI app asked. Your passkey signs exactly that.',
  },
  {
    id: 'revoke',
    title: 'Revoke any time',
    body: 'Nod stops at once, and the allowance is removed from your Stellar account.',
  },
  {
    id: 'gas',
    title: 'No seed phrase, no gas',
    body: 'A passkey owns the wallet and you never need XLM. Nod pays the network fee.',
  },
]

const PROOFS: ReadonlyArray<Proof> = [
  {
    hash: 'c0f6f923936b7dc4d716454ba3e3d3f43f21ddcf353e49e3e083d054bf5f9c57',
    claim: 'An AI app under a 5 USDC allowance spends exactly 5.0; one stroop more fails',
  },
  {
    hash: '3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a',
    claim: 'An over-allowance transfer forced onchain is rejected by the account',
  },
  {
    hash: '4b135c1cba6872a7cdf1ff6e314674e92635243c7f5e4cdc496ed41144888ee1',
    claim: 'A passkey-only account pays with a passkey signature',
  },
  {
    hash: 'f3160c7e183e52c4a633804d60d50a956c627e88bc461be2f8f5fad7b14bb110',
    claim: 'A passkey sets an AI app’s allowance',
  },
  {
    hash: '594e5b6a722a995ee65c42d30807195f808a73b171c7c61234f7720251925a9d',
    claim: 'The AI app’s key fills its pocket under the policy…',
  },
  {
    hash: 'f2d4b987428d4b2a8390e4fd3d54d19c9da4f1bbed54e1d1312ad93894e7c784',
    claim: '…and pays an x402 seller through x402.org',
  },
  {
    hash: '4ddef672157938a4af086bffbf67b66a1e37c8bf7ec8352300019c0398b65671',
    claim: 'A paid MCP tool, settled through OpenZeppelin Channels',
  },
  {
    hash: 'b233c0ccb8ee244602b8fa891c6415062de9be4f2816a23ec87fb5302b4820dd',
    claim: 'Revoke sweeps the pocket back to the wallet',
  },
  {
    hash: 'd931ec2674e48d0f4edb21072937edbc7a21bf7d86cd735005d3c8b599fa4f8e',
    claim: 'A trustline and a payment to a new USDC holder in one transaction',
  },
]

const BUILT_WITH: ReadonlyArray<string> = ['OpenZeppelin smart accounts', 'Circle USDC', 'x402', 'Passkeys', 'Stellar']

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
              h.p([h.Class('text-xs font-semibold uppercase tracking-[0.14em] text-muted')], ['Wallet balance']),
              h.p([h.Class('text-3xl font-semibold tracking-tight tabular-nums text-ink')], ['30.00 USDC']),
              h.p([h.Class('text-sm text-muted')], ['Personal · Stellar testnet']),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-2 bg-paper p-5')],
            [
              h.p([h.Class('text-xs font-semibold uppercase tracking-[0.14em] text-muted')], ['Claude may spend']),
              h.p([h.Class('text-3xl font-semibold tracking-tight tabular-nums text-accent')], ['5.00 USDC']),
              meter(0, 'Claude allowance used', h),
              h.p([h.Class('text-sm text-muted')], ['of 5.00 · until tomorrow 12:00 UTC']),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-2 bg-paper p-5 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between')],
            [
              h.div(
                [h.Class('flex flex-col gap-1')],
                [
                  h.p([h.Class('font-semibold tabular-nums text-ink')], ['20.00 USDC to Bob']),
                  h.p([h.Class('text-sm text-muted')], ['Claude asked · “Dinner with Bob”']),
                ],
              ),
              badge('Needs your nod', 'warn', h),
            ],
          ),
        ],
      ),
      h.figcaption(
        [h.Class('text-sm text-muted')],
        ['Example wallet. Two numbers that never blur: what you hold, and what your AI may spend.'],
      ),
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
              h.p([h.Class('text-sm font-semibold tracking-tight text-accent')], ['nod']),
              badge('Stellar testnet', 'quiet', h),
            ],
          ),
          h.h1(
            [h.Class('text-4xl font-semibold tracking-tight text-balance text-ink sm:text-5xl')],
            ['Give your AI an allowance.'],
          ),
          h.p(
            [h.Class('max-w-xl text-lg text-pretty text-muted')],
            [
              'Nod is a Stellar wallet you add to Claude. Small payments go through on their own, inside the allowance you set. Anything bigger waits for your nod.',
            ],
          ),
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
      sectionHeading(
        'How it works',
        'Three steps, once per AI app. After that, Claude pays inside its allowance and asks you for the rest.',
        h,
      ),
      h.ol(
        [h.Class('grid gap-6 sm:grid-cols-3')],
        Array.map(STEPS, (step, index) => stepItem(step, index + 1, h)),
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
      sectionHeading('Why you can trust it', 'The rules sit in your Stellar account, where the money is.', h),
      h.ul(
        [h.Class('grid gap-6 sm:grid-cols-2')],
        Array.map(TRUST, point => trustItem(point, h)),
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
          h.h2([h.Class('text-2xl font-semibold tracking-tight text-balance text-ink')], ['Pays people too']),
          badge('Trustline required', 'warn', h),
        ],
      ),
      h.p(
        [h.Class('max-w-2xl text-base text-pretty text-muted')],
        [
          'Even people who have never held USDC. Carol gets a claim link for her 5 USDC. She signs once, and her USDC trustline and the payment land in one transaction.',
        ],
      ),
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
      sectionHeading(
        'Proof on Stellar testnet',
        'Each claim links to its transaction on stellar.expert. Nothing here is a mock-up.',
        h,
      ),
      h.ul(
        [h.Class('divide-y divide-line rounded-3xl border border-line bg-paper p-5 sm:p-6')],
        Array.map(PROOFS, proof => proofItem(proof, h)),
      ),
    ],
  )

const tryItView = <Message>(connectorUrl: string, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-6')],
    [
      sectionHeading(
        'Try it in 3 minutes',
        'You need Claude and a device that can make a passkey. Everything runs on Stellar testnet; no real money moves.',
        h,
      ),
      h.ol(
        [h.Class('flex max-w-2xl list-decimal flex-col gap-3 pl-5 text-base text-pretty text-ink marker:text-muted')],
        [
          h.li(
            [],
            [
              'In Claude, open Settings, then Connectors, and add a custom connector with this URL: ',
              h.code([h.Class('select-all break-all font-mono text-sm text-ink')], [connectorUrl]),
            ],
          ),
          h.li(
            [],
            [
              'Connect, create a passkey wallet, and approve Claude’s allowance. Nod funds the new wallet with testnet USDC.',
            ],
          ),
          h.li([], ['Ask Claude to buy the market brief, then to send Alice 2 USDC. Neither asks you.']),
          h.li([], ['Ask Claude to pay Bob 5 USDC for dinner. That is more than what is left, so it needs your nod.']),
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
        Array.map(BUILT_WITH, name => builtWithItem(name, h)),
      ),
      h.p(
        [h.Class('max-w-2xl text-sm text-pretty text-muted')],
        [
          'Built at HackMeridian 2026 for Stellar Composed and Stellar Unlocked. Stellar testnet only. ',
          h.a([h.Href(REPOSITORY_URL), h.Target('_blank'), h.Rel('noreferrer'), h.Class(LINK)], ['Source on GitHub']),
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
