// The words on the signed-out landing, section by section. The copy session owns this file and its vocabulary
// (docs/PITCH.md); landing.ts only draws them, so a change of words never touches the view. The same page is served on
// both hosts: NETWORK_COPY holds the few words that differ between the product (mainnet) and the sandbox (testnet).

export type Point = Readonly<{ id: string; title: string; body: string }>

/** One proof row. `explorer` is the stellar.expert transaction base; without it the row links to testnet. */
export type Proof = Readonly<{ hash: string; claim: string; explorer?: string }>

export type NetworkKind = 'mainnet' | 'testnet'

export const REPOSITORY_URL = 'https://github.com/grmkris/hack-meridian-2026'

export const EXPLORER_TX_URL = 'https://stellar.expert/explorer/testnet/tx/'

export const EXPLORER_PUBLIC_TX_URL = 'https://stellar.expert/explorer/public/tx/'

/** The judges' sandbox: every Try-it step works there with testnet USDC. */
export const SANDBOX_ORIGIN = 'https://testnet.trynod.si'

export const NETWORK_COPY = {
  testnet: {
    badge: 'Stellar testnet',
    tryLead:
      'You need Claude and a device that can make a passkey. This is the sandbox on Stellar testnet: new wallets get 10 testnet USDC, and no real money moves.',
    footerNote:
      'Built at HackMeridian 2026 for the Stellar Composed track. This sandbox runs on Stellar testnet; the product runs on mainnet at trynod.si. ',
  },
  mainnet: {
    badge: 'Stellar mainnet',
    tryLead:
      'You need Claude and a device that can make a passkey. Here on trynod.si, Nod runs on Stellar mainnet and your wallet holds USDC only. To try every step without real money, use the sandbox at testnet.trynod.si, where new wallets get 10 testnet USDC.',
    footerNote:
      'Built at HackMeridian 2026 for the Stellar Composed track. Live on Stellar mainnet; the sandbox at testnet.trynod.si runs on testnet. ',
  },
} as const satisfies Record<NetworkKind, Readonly<{ badge: string; tryLead: string; footerNote: string }>>

export const HERO = {
  wordmark: 'nod',
  title: 'Give your AI an allowance.',
  lede: 'Nod is a Stellar wallet that lives inside the AI you already use. You set one number for each AI app. Inside it, the app pays on its own. Anything past it waits for your nod.',
} as const

// The hero's example wallet. It plays the demo once: the allowance goes 5.00 → 4.90 → 2.90 as Claude pays on its own,
// then Bob's 5.00 is more than what is left, so it needs your nod; the passkey approves it and the allowance stays 2.90.
// Numbers match the demo beats in docs/PITCH.md.
export const EXAMPLE_WALLET = {
  label: 'Example wallet: Claude paying from its allowance',
  allowanceLabel: 'Claude may spend',
  allowanceFigures: ['5.00', '4.90', '2.90'],
  unit: 'USDC',
  allowanceMeterLabel: 'Claude’s allowance left: 2.90 of 5.00',
  allowanceLine: 'of 5.00, until tomorrow 12:00 UTC',
  balanceLabel: 'In your wallet',
  balance: '10.00 USDC',
  payments: [
    { id: 'brief', who: 'Market brief', why: 'A paid API, over x402', amount: '0.10', paid: 'Paid' },
    { id: 'alice', who: 'Alice', why: 'Your contact', amount: '2.00', paid: 'Paid' },
    { id: 'bob', who: 'Bob', why: 'Dinner, Claude asked', amount: '5.00', paid: 'Paid with your nod' },
  ],
  askBadge: 'Needs your nod',
  approve: 'Approve 5.00 USDC to Bob',
  tryNote: 'An example. Tapping it moves no money.',
  replay: 'Play it again',
  approved: 'Approved with your passkey. The allowance stays 2.90.',
  caption: 'Example wallet. The allowance is the one number you set; past it, every payment waits for your nod.',
} as const

export const WHY = {
  title: 'Why Nod',
  lead: 'Apps are turning into conversations and agents. Wallets have to follow them into the chat.',
  points: [
    {
      id: 'conversations',
      title: 'Apps become conversations',
      body: 'You already ask Claude to research, plan and buy. Nod lives in that chat: one connector URL, the wallet’s cards in the conversation, and a notice when money arrives, in AI apps that support them.',
    },
    {
      id: 'allowance',
      title: 'Autonomy needs an allowance',
      body: 'Approving every call kills autonomy, and nobody hands an AI the whole balance. So each AI app gets one allowance, written to your own Stellar account.',
    },
    {
      id: 'onboarding',
      title: 'Every payment can onboard someone',
      body: 'Someone who has never held USDC gets a claim link. They accept it once, and their USDC trustline and your payment land in one transaction.',
    },
  ] satisfies ReadonlyArray<Point>,
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
      title: 'Set one number',
      body: '“5 USDC until tomorrow.” Your passkey signs it, and it is written to your Stellar account.',
    },
    {
      id: 'pay',
      title: 'Let it pay',
      body: 'Paid APIs over x402 and friends by name, inside the allowance. Anything past it comes back as a link for your passkey.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const TRUST = {
  title: 'Why you can trust it',
  lead: 'The rules sit in your Stellar account, where the money is.',
  points: [
    {
      id: 'onchain',
      title: 'The limit lives on your Stellar account',
      body: 'An OpenZeppelin spending-limit policy on your account holds each AI app to its allowance. The most Nod’s service could ever spend for an app is what you set, pocket included.',
    },
    {
      id: 'exact',
      title: 'Your passkey approves each payment past it',
      body: 'The link shows the recipient’s name and address, the amount and which AI app asked. Your passkey signs that payment on Nod’s own page, never in the chat.',
    },
    {
      id: 'revoke',
      title: 'Revoke any time',
      body: 'Nod stops signing at once and sweeps the pocket back. One passkey tap removes the allowance from your Stellar account.',
    },
    {
      id: 'gas',
      title: 'No seed phrase, no XLM',
      body: 'A passkey owns the wallet and you hold only USDC. Nod pays the network fee.',
    },
  ] satisfies ReadonlyArray<Point>,
} as const

export const CLAIM = {
  title: 'Pays people too',
  badge: 'Trustline required',
  body: 'Even people who have never held USDC. Carol gets a claim link for her 1 USDC. She accepts it once, and her USDC trustline and the payment land in one transaction.',
} as const

// Mainnet rows come from evidence/mainnet/claude-run-2026-10-25.md; the two testnet rows are spike S1, the limit
// itself. Every hash was checked successful on Horizon before it went here.
export const PROOF = {
  title: 'Proof on Stellar',
  lead: 'Each claim links to its transaction on stellar.expert. The flow ran on Stellar mainnet, in claude.ai, on the founder’s own wallet; the last two rows are testnet spikes that test the limit itself.',
  items: [
    {
      hash: '6485e55cd8f69d51b60f608bdc253d40c3d7ee02f9b86bcccd6cefbeeb08c7bb',
      claim: 'An x402 purchase: Claude’s key pulls 1 USDC into its pocket under the allowance…',
      explorer: EXPLORER_PUBLIC_TX_URL,
    },
    {
      hash: 'cb296cc3a539cfaf966d79fa3662e48e83e3f1fb01fe9be24b767d3c3c8dea58',
      claim: '…and OpenZeppelin Channels settles 0.10 USDC from the pocket to the seller',
      explorer: EXPLORER_PUBLIC_TX_URL,
    },
    {
      hash: 'c8ee8b5ad7599b9db13a4dd551a918d55ecafc6de2f31c79a61fcc7edb1032cb',
      claim: '2 USDC to Alice, signed by Claude’s key inside its allowance',
      explorer: EXPLORER_PUBLIC_TX_URL,
    },
    {
      hash: '0339b8dd088b46d500de425d0afe8707ff6922186ef70070396323f2d3312e4f',
      claim: '5 USDC to Bob, past the allowance, approved with the passkey',
      explorer: EXPLORER_PUBLIC_TX_URL,
    },
    {
      hash: '1fe4e852314ea638ed53ba79acebc60a129b587e0ef80c9b051d434aa01e68c6',
      claim: 'Carol’s USDC trustline and 1 USDC in one transaction',
      explorer: EXPLORER_PUBLIC_TX_URL,
    },
    {
      hash: 'ab6d493d483f6ea5d560a9561ab7cdd2668b9d7597632023095a397ca1fd53dd',
      claim: 'Revoke sweeps the pocket back to the wallet',
      explorer: EXPLORER_PUBLIC_TX_URL,
    },
    {
      hash: 'e17e15d5efd2f43e883073873ff9d5dc0333ea9dca318cea0f38a5c7678f04c9',
      claim: 'One passkey tap removes the allowance rule from the account',
      explorer: EXPLORER_PUBLIC_TX_URL,
    },
    {
      hash: 'c0f6f923936b7dc4d716454ba3e3d3f43f21ddcf353e49e3e083d054bf5f9c57',
      claim: 'Testnet: a 5 USDC allowance spends exactly 5.0; one stroop more fails',
      explorer: EXPLORER_TX_URL,
    },
    {
      hash: '3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a',
      claim: 'Testnet: an over-allowance transfer forced onchain is rejected by the account',
      explorer: EXPLORER_TX_URL,
    },
  ] satisfies ReadonlyArray<Proof>,
} as const

// Every step works on the sandbox, so on mainnet the connector shown is the sandbox's and the sample link leaves for it.
export const TRY_IT = {
  title: 'Try it in 3 minutes',
  connectorStep: 'In Claude, open Settings, then Connectors, and add a custom connector with this URL: ',
  steps: [
    'Connect, create a passkey wallet, and set Claude’s allowance to 5 USDC. Nod funds a new sandbox wallet with 10 testnet USDC.',
    'Ask Claude to buy the market brief, then to send Alice 2 USDC. Neither asks you.',
    'Ask Claude to pay Bob 5 USDC for dinner. That is more than what is left, so it needs your nod.',
  ],
  sampleLead: 'No Claude at hand? ',
  sample: 'Watch a sample agent run on Nod’s own demo wallet',
  sampleHref: { testnet: '/sample', mainnet: `${SANDBOX_ORIGIN}/sample` },
  sampleNote:
    'The same steps, through the same tools Claude calls, on Nod’s own demo wallet in the sandbox. A live log shows every amount, nod, fee and transaction.',
} as const

// The page ends at dawn, under the last plate: a callback to the tagline (Nod pays in seconds, so no "by morning").
export const DAWN = {
  line: 'The small stuff got paid. The big one waited for your nod.',
} as const

export const FOOTER = {
  builtWith: ['OpenZeppelin smart accounts', 'Circle USDC', 'x402', 'Passkeys', 'Stellar'],
  source: 'Source on GitHub',
} as const
