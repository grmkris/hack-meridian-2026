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
    footerNote: 'Your wallet, wherever the conversation goes. ',
  },
} as const satisfies Record<NetworkKind, Readonly<{ badge: string; footerNote: string }>>

export const HERO = {
  wordmark: 'nod',
  title: 'The wallet that lives inside your AI.',
  lede: 'Connect Nod to Claude or ChatGPT. Pay for APIs and send USDC to people, right from your chat.',
} as const

export const WHY = {
  title: 'Payments, inside the conversation.',
  lead: 'Let your AI finish the tasks that need a payment.',
  points: [
    {
      id: 'conversations',
      title: 'Keep it in the chat',
      body: 'Check your balance and manage contacts in the same chat you use to make a payment.',
    },
    {
      id: 'services',
      title: 'Pay for what your AI needs',
      body: 'Your AI can buy data and API access from services that accept USDC over x402.',
    },
    {
      id: 'onboarding',
      title: 'Send money to people',
      body: 'Ask your AI to pay a contact or make a payment link for someone new to Nod.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const HOW_IT_WORKS = {
  title: 'How it works',
  lead: 'Create your wallet, add USDC, and connect your AI.',
  steps: [
    {
      id: 'connect',
      title: 'Add Nod to your AI',
      body: 'Paste the connector URL into Claude or a compatible AI app. In ChatGPT, use a developer-mode connector.',
    },
    {
      id: 'allowance',
      title: 'Choose what it can spend',
      body: 'Set a total for routine payments and how long it lasts. Confirm with your passkey.',
    },
    {
      id: 'pay',
      title: 'Ask it to pay',
      body: 'Small payments go through on their own. When a payment needs your nod, your AI gives you a link to approve it.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const TRUST = {
  title: 'You stay in control',
  lead: 'You decide what your AI can pay for on its own.',
  points: [
    {
      id: 'onchain',
      title: 'A limit for each app',
      body: 'Each AI app has its own spending limit. Anything beyond it needs your approval.',
    },
    {
      id: 'exact',
      title: 'Know what you approve',
      body: 'See the recipient and exact amount before you confirm a payment with your passkey.',
    },
    {
      id: 'revoke',
      title: 'Change your mind',
      body: 'Adjust a spending limit or disconnect an AI app from your wallet.',
    },
    {
      id: 'gas',
      title: 'No seed phrase. No gas to manage.',
      body: 'You use USDC and a passkey. Nod pays the network fee.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const CLAIM = {
  title: 'Send money with a link.',
  body: 'Send USDC to a friend with a payment link. They open it, create a wallet with a passkey, and receive the money. If they already use Nod, they can sign in.',
} as const

export const DAWN = {
  line: 'Small stuff, it just pays. Big stuff needs your nod.',
} as const

export const FOOTER = {
  source: 'Source on GitHub',
} as const
