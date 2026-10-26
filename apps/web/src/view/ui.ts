import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Readiness } from '@hm/protocol'

// SHARED STYLES

const PRESSABLE =
  'inline-flex min-h-11 touch-manipulation select-none items-center justify-center rounded-full px-5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-[color,background-color,border-color,scale] motion-safe:active:scale-[0.97] [.wallet-app_&]:rounded-lg [.wallet-app_&]:px-4 [.wallet-app_&]:disabled:opacity-100 [.wallet-app_&]:disabled:bg-mist [.wallet-app_&]:disabled:text-muted [.wallet-app_&]:disabled:border-line [.wallet-app_&]:motion-safe:enabled:active:scale-[0.96]'

export const BUTTON_PRIMARY = `${PRESSABLE} bg-night text-starlight hover:bg-night-raised active:bg-night-raised focus-visible:outline-accent`
export const BUTTON_SECONDARY = `${PRESSABLE} border border-line bg-paper text-ink hover:bg-mist active:bg-mist focus-visible:outline-accent`
export const BUTTON_DANGER = `${PRESSABLE} bg-danger text-paper hover:bg-danger/90 active:bg-danger/90 focus-visible:outline-danger`
/** The nod moment only: a payment waiting for the owner's passkey. */
export const BUTTON_NOD = `${PRESSABLE} bg-lamp text-on-lamp hover:bg-lamp/85 active:bg-lamp/85 focus-visible:outline-accent`
export const LINK =
  'font-medium text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
export const INPUT =
  'min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base text-ink placeholder:text-muted focus:border-accent focus:outline-2 focus:outline-accent/30'
/** The two numbers and other amounts a person reads first. */
export const FIGURE = 'font-display font-bold tracking-[-0.015em] tabular-nums lining-nums'

// LAYOUT

export const pageHeader = <Message>(title: string, lead: string, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('flex flex-col gap-1.5')],
    [
      h.h1([h.Class('font-display text-3xl font-bold tracking-[-0.015em] text-ink sm:text-4xl')], [title]),
      h.p([h.Class('max-w-prose text-sm text-muted')], [lead]),
    ],
  )

export const panel = <Message>(title: string, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('border-t border-line py-5')],
    [h.h2([h.Class('mb-4 text-sm font-semibold text-muted')], [title]), ...children],
  )

export const loadingRow = <Message>(h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('py-6 text-sm text-muted'), h.AriaLive('polite')], ['Loading…'])

export const errorRow = <Message>(error: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('alert'), h.Class('rounded-2xl bg-danger/8 px-4 py-3 text-sm text-danger')], [error])

export const emptyRow = <Message>(text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('rounded-2xl bg-mist px-4 py-5 text-center text-sm text-muted')], [text])

// BADGES

type Tone = 'good' | 'warn' | 'bad' | 'quiet' | 'accent'

const TONE: Readonly<Record<Tone, string>> = {
  good: 'bg-good/10 text-good ring-good/25',
  warn: 'bg-warn/12 text-warn ring-warn/30',
  bad: 'bg-danger/10 text-danger ring-danger/25',
  quiet: 'bg-mist text-muted ring-line',
  accent: 'bg-accent/8 text-accent ring-accent/20',
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
  account_missing: { label: 'Account missing', tone: 'bad', help: 'This address does not exist on Stellar yet.' },
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
      h.Class('h-2 w-full overflow-clip rounded-full bg-mist'),
    ],
    [h.div([h.Class('h-full rounded-full bg-accent'), h.Style({ width: `${100 - percentUsed}%` })])],
  )
