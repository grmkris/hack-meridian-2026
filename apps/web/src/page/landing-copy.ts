// The words on the signed-out landing, section by section. The pitch session (a3) owns this file and its vocabulary
// (docs/PITCH.md); landing.ts only draws them, so a change of words never touches the view.

export type Point = Readonly<{ id: string; title: string; body: string }>

export type Proof = Readonly<{ hash: string; claim: string }>

export const REPOSITORY_URL = 'https://github.com/grmkris/hack-meridian-2026'

export const EXPLORER_TX_URL = 'https://stellar.expert/explorer/testnet/tx/'

export const HERO = {
  wordmark: 'nod',
  network: 'Stellar testnet',
  title: 'Give your AI an allowance.',
  lede: 'Nod is a Stellar wallet you add to Claude. Small payments go through on their own, inside the allowance you set. Anything bigger waits for your nod.',
} as const

// The hero's example wallet. It plays the demo once: the allowance goes 5.00 → 4.90 → 2.90 as Claude pays on its own,
// then Bob's 20.00 needs your nod, the passkey approves it, and the allowance stays 2.90. Numbers match docs/PITCH.md.
export const EXAMPLE_WALLET = {
  label: 'Example wallet: Claude paying from its allowance',
  allowanceLabel: 'Claude may spend',
  allowanceFigures: ['5.00', '4.90', '2.90'],
  unit: 'USDC',
  allowanceMeterLabel: 'Claude’s allowance left: 2.90 of 5.00',
  allowanceLine: 'of 5.00, until tomorrow 12:00 UTC',
  balanceLabel: 'In your wallet',
  balance: '30.00 USDC',
  payments: [
    { id: 'brief', who: 'Market brief', why: 'A paid API, over x402', amount: '0.10', paid: 'Paid' },
    { id: 'alice', who: 'Alice', why: 'Your contact', amount: '2.00', paid: 'Paid' },
    { id: 'bob', who: 'Bob', why: 'Dinner, Claude asked', amount: '20.00', paid: 'Paid with your nod' },
  ],
  askBadge: 'Needs your nod',
  approve: 'Approve 20.00 USDC to Bob with your passkey',
  approved: 'Approved with your passkey. The allowance stays 2.90.',
  caption: 'Example wallet. Two numbers that never blur: what you hold, and what your AI may spend.',
} as const

export const HOW_IT_WORKS = {
  title: 'How it works',
  lead: 'Three steps, once per AI app. After that, Claude pays inside its allowance and asks you for the rest.',
  steps: [
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
  ] satisfies ReadonlyArray<Point>,
} as const

export const TRUST = {
  title: 'Why you can trust it',
  lead: 'The rules sit in your Stellar account, where the money is.',
  points: [
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
  ] satisfies ReadonlyArray<Point>,
} as const

export const CLAIM = {
  title: 'Pays people too',
  badge: 'Trustline required',
  body: 'Even people who have never held USDC. Carol gets a claim link for her 5 USDC. She signs once, and her USDC trustline and the payment land in one transaction.',
} as const

export const PROOF = {
  title: 'Proof on Stellar testnet',
  lead: 'Each claim links to its transaction on stellar.expert. Nothing here is a mock-up.',
  items: [
    {
      hash: 'fb77bd0f01aeb515b967e7bf5f7d0b1f8ec5c4c6af7889263ed3172a0a8ebefe',
      claim: '2 USDC to Alice, signed by the AI app’s key inside its allowance',
    },
    {
      hash: 'fbfd200cc85525ee65a0a55f4b3dc338eedf37c1c8273abcc0ac7701f09e97da',
      claim: '20 USDC to Bob, over the allowance, approved with the passkey',
    },
    {
      hash: '565b7f0740d2cb73975939107c6b3329a03d60d26925101ba7e9a7ae5660735c',
      claim: 'Carol’s USDC trustline and 5 USDC in one transaction',
    },
    {
      hash: '55beab6dd2866dd95f6bfcc7209d4c3c7e8a423d4955de5607a6009da1003279',
      claim: 'Revoke removes the allowance rule from the account',
    },
    {
      hash: '00129674edaed2fcce96c73745587f2c599704850c182c38f7d7c12ab5ee55a6',
      claim: 'Revoke sweeps the pocket back to the wallet',
    },
    {
      hash: '978479126c9339de3a2cf4140dcef4958aa13d95ea39408b50cbf4ae413ed702',
      claim: 'An x402 purchase: the AI app’s key pulls 1 USDC into its pocket under the allowance…',
    },
    {
      hash: 'e3e62e07dbf11f0bd75ac795a3bef5a50fcc6ffd64e610c98a70dc9676890990',
      claim: '…and OpenZeppelin Channels settles 0.10 USDC from the pocket to the seller',
    },
    {
      hash: 'c0f6f923936b7dc4d716454ba3e3d3f43f21ddcf353e49e3e083d054bf5f9c57',
      claim: 'A 5 USDC allowance spends exactly 5.0; one stroop more fails',
    },
    {
      hash: '3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a',
      claim: 'An over-allowance transfer forced onchain is rejected by the account',
    },
  ] satisfies ReadonlyArray<Proof>,
} as const

export const TRY_IT = {
  title: 'Try it in 3 minutes',
  lead: 'You need Claude and a device that can make a passkey. Everything runs on Stellar testnet; no real money moves.',
  connectorStep: 'In Claude, open Settings, then Connectors, and add a custom connector with this URL: ',
  steps: [
    'Connect, create a passkey wallet, and approve Claude’s allowance. Nod funds the new wallet with testnet USDC.',
    'Ask Claude to buy the market brief, then to send Alice 2 USDC. Neither asks you.',
    'Ask Claude to pay Bob 5 USDC for dinner. That is more than what is left, so it needs your nod.',
  ],
  sampleLead: 'No Claude at hand? ',
  sample: 'Watch a sample agent run',
  sampleHref: '/sample',
} as const

export const FOOTER = {
  builtWith: ['OpenZeppelin smart accounts', 'Circle USDC', 'x402', 'Passkeys', 'Stellar'],
  note: 'Built at HackMeridian 2026 for the Stellar Composed track. Stellar testnet only. ',
  source: 'Source on GitHub',
} as const
