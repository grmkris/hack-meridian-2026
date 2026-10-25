import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Readiness } from '@hm/protocol'

// SHARED STYLES

export const BUTTON_PRIMARY =
  'inline-flex min-h-11 items-center justify-center rounded-full bg-ink px-5 text-sm font-semibold text-paper transition hover:bg-ink/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50'
export const BUTTON_SECONDARY =
  'inline-flex min-h-11 items-center justify-center rounded-full border border-line bg-paper px-5 text-sm font-semibold text-ink transition hover:bg-mist focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50'
export const BUTTON_DANGER =
  'inline-flex min-h-11 items-center justify-center rounded-full bg-danger px-5 text-sm font-semibold text-paper transition hover:bg-danger/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:cursor-not-allowed disabled:opacity-50'
export const LINK = 'font-medium text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent'
export const INPUT =
  'min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base text-ink placeholder:text-muted focus:border-accent focus:outline-2 focus:outline-accent/30'

// LAYOUT

export const pageHeader = <Message>(title: string, lead: string, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('flex flex-col gap-1')],
    [
      h.h1([h.Class('text-2xl font-semibold tracking-tight text-ink sm:text-3xl')], [title]),
      h.p([h.Class('max-w-prose text-sm text-muted')], [lead]),
    ],
  )

export const panel = <Message>(title: string, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('rounded-3xl border border-line bg-paper p-5 shadow-[0_1px_0_rgb(0_0_0/0.03)] sm:p-6')],
    [h.h2([h.Class('mb-4 text-xs font-semibold uppercase tracking-[0.14em] text-muted')], [title]), ...children],
  )

export const loadingRow = <Message>(h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('py-6 text-sm text-muted'), h.AriaLive('polite')], ['Loading…'])

export const errorRow = <Message>(error: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('alert'), h.Class('rounded-2xl bg-danger/8 px-4 py-3 text-sm text-danger')], [error])

export const emptyRow = <Message>(text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted')], [text])

// BADGES

type Tone = 'good' | 'warn' | 'bad' | 'quiet' | 'accent'

const TONE: Readonly<Record<Tone, string>> = {
  good: 'bg-good/10 text-good ring-good/25',
  warn: 'bg-warn/12 text-warn ring-warn/30',
  bad: 'bg-danger/10 text-danger ring-danger/25',
  quiet: 'bg-mist text-muted ring-line',
  accent: 'bg-accent/10 text-accent ring-accent/25',
}

export const badge = <Message>(text: string, tone: Tone, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(
        `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONE[tone]}`,
      ),
    ],
    [text],
  )

const READINESS: Readonly<Record<Readiness, Readonly<{ label: string; tone: Tone; help: string }>>> = {
  usdc_ready: { label: 'USDC ready', tone: 'good', help: 'Can receive USDC now.' },
  trustline_required: {
    label: 'Trustline required',
    tone: 'warn',
    help: 'Gets a claim link: accepting it adds USDC and pays in one step.',
  },
  account_missing: { label: 'Account missing', tone: 'bad', help: 'This address does not exist on testnet yet.' },
  unverified: { label: 'Unverified', tone: 'quiet', help: 'Checked against the chain at the next payment.' },
}

export const readinessBadge = <Message>(readiness: Readiness, h: HtmlBuilder<Message>): Html =>
  badge(READINESS[readiness].label, READINESS[readiness].tone, h)

export const readinessHelp = (readiness: Readiness): string => READINESS[readiness].help

// ALLOWANCE

export const meter = <Message>(percentUsed: number, label: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('meter'),
      h.AriaLabel(label),
      h.AriaValuenow(percentUsed),
      h.AriaValuemin(0),
      h.AriaValuemax(100),
      h.Class('h-2 w-full overflow-hidden rounded-full bg-mist'),
    ],
    [h.div([h.Class('h-full rounded-full bg-accent transition-[width]'), h.Style({ width: `${100 - percentUsed}%` })])],
  )
