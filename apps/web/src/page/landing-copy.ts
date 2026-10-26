// The words on the signed-out landing, section by section. The copy session owns this file and its vocabulary.
// The same page is served on both hosts: NETWORK_COPY keeps the environment cue useful without exposing internals.

export type Point = Readonly<{ id: string; title: string; body: string }>

export type NetworkKind = 'mainnet' | 'testnet'

export const REPOSITORY_URL = 'https://github.com/grmkris/hack-meridian-2026'

export const NETWORK_COPY = {
  testnet: {
    badge: 'Sandbox',
    footerNote: 'Try Nod safely in the sandbox. No real money moves. ',
  },
  mainnet: {
    badge: 'Live',
    footerNote: 'Nod gives your AI room to act while you stay in control. ',
  },
} as const satisfies Record<NetworkKind, Readonly<{ badge: string; footerNote: string }>>

export const HERO = {
  wordmark: 'nod',
  title: 'Give your AI an allowance.',
  lede: 'Nod gives your AI a small budget. It can pay for the things you ask, and anything beyond that waits for you.',
} as const

export const WHY = {
  title: 'Why Nod',
  lead: 'Let your AI handle small payments while you stay in charge.',
  points: [
    {
      id: 'conversations',
      title: 'It works where you work',
      body: 'Nod lives alongside your AI, so you can ask, plan, and pay in one conversation.',
    },
    {
      id: 'allowance',
      title: 'Set the boundary',
      body: 'Give each AI app a budget. It can act freely inside it, then ask when it reaches the edge.',
    },
    {
      id: 'onboarding',
      title: 'Send money simply',
      body: 'Share a payment link with anyone. They can open it and receive the money with a passkey.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const HOW_IT_WORKS = {
  title: 'Connect your AI',
  lead: 'A few steps once. Then your AI can act within the limit you choose.',
  steps: [
    {
      id: 'connect',
      title: 'Connect',
      body: 'Add Nod to Claude or another AI app with one connector URL.',
    },
    {
      id: 'allowance',
      title: 'Set a limit',
      body: 'Choose how much it can spend. Your passkey saves the limit.',
    },
    {
      id: 'pay',
      title: 'Let it act',
      body: 'It pays inside that limit and asks you when a payment needs your say.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const TRUST = {
  title: 'You stay in control',
  lead: 'Nod makes room for your AI without handing over your wallet.',
  points: [
    {
      id: 'onchain',
      title: 'Set the limit',
      body: 'Choose what an AI app can spend. It cannot go past that amount on its own.',
    },
    {
      id: 'exact',
      title: 'Approve the rest',
      body: 'When a payment needs your say, Nod shows who gets paid and how much. Your passkey confirms it.',
    },
    {
      id: 'revoke',
      title: 'Change it anytime',
      body: 'Raise, lower, or remove an allowance whenever you want.',
    },
    {
      id: 'gas',
      title: 'No seed phrase',
      body: 'Your passkey protects the wallet. Nod handles the network fees.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const CLAIM = {
  title: 'Pays people too',
  body: 'Send money to someone who has never used Nod. They open a link, create a passkey wallet, and receive it.',
} as const

export const DAWN = {
  line: 'The small stuff got paid. The big one waited for your nod.',
} as const

export const FOOTER = {
  source: 'Source on GitHub',
} as const
