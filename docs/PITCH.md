# Pitch: Nod

Status: v2, 2026-10-25 19:30 UTC. Owner: session D (copy, deck, video, submission). Product facts come from
`docs/SPEC.md`, evidence from `evidence/` and `docs/spikes/`. This file decides the words; every user-facing surface
(landing page, README, portal answers, deck, video, `llms.txt`) uses them. A claim enters copy only when its proof
exists, and only in the wording below. "What we may say" lists the proof behind each one.

## Name and lines

**Nod** in prose, **nod** in the wordmark. The repository stays `hack-meridian-2026`.

- Tagline, exact: **Small stuff, it just pays. Big stuff needs your nod.**
- Product line: **Give your AI an allowance.**
- Category line, for people who need one: _a Stellar wallet that lives inside the AI you already use._

## Why Nod

Apps are turning into conversations and agents. People already ask Claude to research, plan and buy, and the chat is
where that work happens. A wallet in a browser extension or a separate app sits outside it, so wallets have to follow
the apps into the conversation.

MCP is how a wallet gets there. A host that renders MCP Apps draws the wallet's own cards in the chat: the balance, a
payment waiting for you, the receipt. A host that takes MCP Events lets the wallet tell you when money arrives or a
payment needs you. Nod's cards and its approval link run live in Goblin, claude.ai and ChatGPT (as a developer-mode
connector). Its notifications arrive in Goblin and ChatGPT; claude.ai and Claude Code do not implement MCP Events yet,
so there the cards poll.

Getting in should feel like any other app. You sign up with a passkey and hold USDC, and you never meet XLM, a seed
phrase or a trustline. From then on the wallet does what wallets do: send, receive, pay.

Every agent wallet then hits the same wall. If you approve every call, the AI is no longer autonomous, and nobody
trusts an AI with the whole balance. Nod's answer is one number. You give each AI app one allowance, say 5 USDC until
tomorrow. Inside it, the app pays on its own. Anything past it needs your passkey, every time, for any amount. The
allowance is an OpenZeppelin spending-limit policy on your own Stellar account.

The people you pay come along. When someone cannot receive USDC yet, the payment becomes a link, so paying them is how
they join. Today the link serves anyone with a Stellar account who has never held USDC: you nod once, they accept with
Freighter within 30 minutes (their account needs about 0.5 XLM for the trustline reserve), and the USDC trustline and
the payment land in one transaction. On the testnet sandbox the link already creates a Nod wallet for someone with
nothing at all; mainnet follows.

## What Nod is, in 30 seconds

> Apps are turning into conversations, so your wallet should live in the chat too. Nod is a Stellar wallet you add to
> Claude with one connector URL. You give each AI app one allowance, say 5 USDC until tomorrow. Inside it, the app pays
> for APIs and pays people on its own. Anything past it comes back as a link, and your passkey signs that payment,
> every time, for any amount. The allowance is an OpenZeppelin spending-limit policy on your own Stellar account, so
> the most Nod's service could ever spend for an AI app is the allowance you set, pocket included. The full flow runs
> on Stellar mainnet today, at trynod.si.

## Four messages, repeated everywhere

1. **It lives in the AI you already use.** One connector URL in Claude, ChatGPT, Goblin, Claude Code or any MCP app.
   Cards in the chat where the host renders MCP Apps.
2. **One number.** The allowance is what the AI may spend alone until it expires. Past it, your passkey approves each
   payment, whatever the amount.
3. **The limit lives on your Stellar account.** OpenZeppelin's smart account and spending-limit policy enforce it. x402
   sellers are paid through public facilitators (x402.org, OpenZeppelin Channels).
4. **A payment can be someone's way in.** A person with no USDC gets a claim link; their trustline and the payment land
   in one transaction (CAP-73).

## Why this is not another agent wallet

At least a dozen entries at Stellar Hacks: Agents (April 2026, 249 submissions) built agent wallets with spending
limits; none placed. The placed projects had a concrete user and reached the real world (real cards, a marketplace, paid
APIs, seller tooling). HackMeridian's Composed track names "Agents that spend" as its first example, so expect
look-alikes here too. Nod's first 15 seconds must show what the others did not have:

| Typical agent wallet                 | Nod                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------- |
| SDK or contract for agent developers | a connector a person adds to Claude, with cards in the chat                 |
| over the limit = blocked             | past the allowance = a link your passkey signs, for that one payment        |
| its own policy contract              | OpenZeppelin's account and spending-limit policy                            |
| its own payment path                 | stock x402 through public facilitators (the pocket model)                   |
| pays APIs                            | pays APIs and people, including people who have never held USDC             |
| a testnet demo                       | the full flow on Stellar mainnet, in claude.ai, on the founder's own wallet |

## What we may say, and the proof

| Say (this wording)                                                                                                                                                                                                                                                                                                                                                                                   | Proof                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "The full flow runs on Stellar mainnet at trynod.si, in claude.ai, on the founder's own wallet: an x402 purchase settled by OpenZeppelin Channels, a payment inside the allowance, one that needed the nod, a claim link that created a trustline and paid in one transaction, a revoke that removed the rule and swept the pocket."                                                                 | `evidence/mainnet/claude-run-2026-10-25.md`: consent `f803994b…`, pull `6485e55c…`, settlement `cb296cc3…`, Alice `c8ee8b5a…`, Bob `0339b8dd…`, Carol `1fe4e852…`, rule removed `e17e15d5…`, pocket swept `ab6d493d…`                                                                                        |
| "On mainnet, Claude bought Stellar's own x402 demo endpoint, a seller Nod does not run, settled through OpenZeppelin Channels."                                                                                                                                                                                                                                                                      | `evidence/mainnet/claude-run-2026-10-25.md` (20:54 UTC section): `stellar.org/x402-demo/api/protected/mainnet`, 0.01 USDC, pull `aa20431d…`, settlement `3a63573a…` to Stellar's pay-to account, fee paid by the facilitator                                                                                 |
| "One rehearsal on the live site passed acceptance tests 1, 2 and 4–9; test 3, a forced over-limit transfer, cannot be sent through MCP by design and is proven onchain in spike S1 (`3daf4b00…`)."                                                                                                                                                                                                   | `evidence/demo/2026-10-25T18-31-37-970Z/run.json` (testnet, release `9fc080f`)                                                                                                                                                                                                                               |
| "In hosts that render MCP Apps, Nod's cards appear in the chat; in hosts that take MCP Events, Nod tells you when money arrives or a payment needs you. Shown live in Goblin, claude.ai and ChatGPT." Events: Goblin and ChatGPT only. ChatGPT always as "works in ChatGPT as a developer-mode connector (cards, the nod, events); not listed in its app store, whose policy bars crypto transfers". | `evidence/mcp-apps/README.md`: claude-01…04, goblin-01…09, chatgpt-01…07; `payment.received` by webhook in Goblin (`091942b4…`) and ChatGPT (`c85e7693…`)                                                                                                                                                    |
| "A recipient with no USDC trustline gets the trustline and the payment in one transaction."                                                                                                                                                                                                                                                                                                          | testnet `565b7f07…`, `2b3abb65…`; mainnet `1fe4e852…`                                                                                                                                                                                                                                                        |
| "A 5 USDC allowance spends exactly 5.0; one stroop more fails." "An over-allowance transfer forced onchain is rejected by the account."                                                                                                                                                                                                                                                              | spike S1: `c0f6f923…`, `3daf4b00…` (`#3221`)                                                                                                                                                                                                                                                                 |
| "Add it to claude.ai" and "Claude Code connects over OAuth."                                                                                                                                                                                                                                                                                                                                         | `evidence/mcp-apps/` (claude.ai), spike S4 (Claude Code)                                                                                                                                                                                                                                                     |
| "Open to anyone, USDC only." "Deposit from any exchange or wallet to your deposit address, no memo; it lands in your wallet." True on mainnet and testnet.                                                                                                                                                                                                                                           | mainnet: `evidence/mainnet/deposit-2026-10-25T21-46Z.md` (a stranger-style signup with nothing onchain; deposit `d1c91074…`, sweep `7c57d530…`, account deployed `57b97375…` 83 s later, about 0.30 XLM in fees paid by Nod); testnet: `docs/spikes/s8-deposit.md`, `evidence/deposit-first/`                |
| "Top up from any chain: Add money → From another chain, or ask Claude; NEAR Intents' 1Click pays USDC to your deposit address." Live on mainnet only (1Click has no testnet). Until a funded top-up has a hash, the proof is the dry-run quote: "5 USDC on Base → 4.98 USDC on Stellar in about 50 seconds", never "a top-up arrived".                                                               | `evidence/topup/dry-quote-2026-10-25T22-07-19-789Z.json` (through Nod's own 1Click client against the hosted API), `evidence/topup/tools-list-diff.txt` (23 tools, the first 21 byte-identical), `docs/NEAR-INTENTS.md`                                                                                      |
| Live on testnet, always with those words: "sign up with a passkey and a deposit: the account deploys when the first USDC lands"; "pay someone who is not on Stellar: they open the link, create a wallet with a passkey, and the USDC lands in it"; "Claude adds contacts; the first payment to one it added needs your nod"; "Claude asks to change its allowance with a link your passkey signs".  | public host `testnet.trynod.si` at `3473ee4`: `evidence/deposit-first/` (deposit `06bd7d2e…`, sweep `04704caf…`, deploy `8c356236…`), `evidence/claims/` (Jan `eb9def8c…`, his wallet `bccfbc61…`), `evidence/tools/` (Dave `b5efd05d…` by nod, `016a0772…` alone, allowance `3ff0e2e0…`), `evidence/shots/` |
| Live on testnet: "Past the allowance, your one passkey tap makes a link that is an allowance for one person: a rule for exactly the amount, valid seven days. The key is made in your browser and lives only in the link." Trust line, verbatim: "Nod never holds the link key or the funds; a leaked link can take at most the amount, once, before it expires."                                    | public host at `4bb4a89`: `evidence/person-link/` (rule `929c79eb…`, Jan's claim `fd54c526…`, Jan's wallet `fee254cc…`, 6.0000001 refused `#3221` in enforcing simulation while exactly 6 passes, second claim refused, take-back `1803a30c…`)                                                               |

Not yet, until the orchestrator says the proof exists: mainnet wording for wallet-creating links, the link as an
allowance for one person and AI-added contacts (the person link goes to mainnet copy only after the recording's mainnet
hash), and a ChatGPT app store listing.

## Never say

"audited" · "nine of nine" · "nod line" or any second threshold · a cap or limit on payments you approve · "no limit on
what Claude can spend" · CCTP · a facilitator of ours · privacy · recovery · "ChatGPT support" or "in the ChatGPT app
store" (say "works in ChatGPT as a developer-mode connector") · "ephemeral pocket" · "exact payment" for the pocket (it
fills in 1 USDC steps) · "atomic wallet creation" · "on EVM this needs approval hops" · "sent to your phone" (the link
opens wherever your passkey is) · MCP Events in claude.ai or Claude Code · "pay any address silently".

## Wording, ready to paste

- One number: "You give each AI app one allowance, say 5 USDC until tomorrow. Inside it, the app pays on its own.
  Anything past it needs your passkey, every time, for any amount."
- Security: "The allowance is an OpenZeppelin spending-limit policy on your own Stellar account. The most Nod's service
  could ever spend for an AI app is the allowance you set, pocket included."
- Revoke: "Revoke stops Nod signing at once and sweeps the pocket back; one passkey tap removes the allowance from your
  account."
- Where the nod happens: "Your passkey signs on Nod's own page, never in the chat. A link, on your phone or your laptop."
- Pocket: "Hosted x402 facilitators do not take smart-account payers yet, so each AI app's key also owns a small pocket
  account, filled from your wallet under the same policy in 1 USDC steps. Both transactions are on the receipt."
- Claim link: "Someone who has never held USDC gets a link. You nod once; they accept with Freighter within 30 minutes,
  and their USDC trustline and the payment land in one transaction."
- Why Stellar: "Native passkey verification, OpenZeppelin's account rules, and CAP-73, which lets a recipient's first
  signature create the USDC trustline alongside the payment."
- Prior work: "Kristjan built Froggy at ETHOnline 2026, an agent wallet on Base and Hedera whose limits were enforced by
  its own server; no Froggy code is used here, and Nod moves the limit onto the account itself."

## For AI apps

README and `llms.txt` open with: "Read https://trynod.si/SKILL.md and follow it before paying anything on a user's
behalf." That file is Nod's bundled skill, `nod-guide` (`apps/web/public/skill/nod-guide/`, also served as
`skill://nod-guide/SKILL.md` and through the `get_guide` tool): how to read the allowance, pay, ask for the nod, wait,
add money and recover from errors. Its words follow this file, and its error recovery sentences
(`references/errors.md`) are the ones the tools return.

## Vocabulary

| Say                                                   | Not                                                   |
| ----------------------------------------------------- | ----------------------------------------------------- |
| allowance (the one number you set)                    | grant, budget rule, context rule, session key, limits |
| needs your nod / asks you / approve with your passkey | owner lane, escalation, requires_approval, nod line   |
| AI app, Claude                                        | MCP client, connection (fine in tech docs)            |
| cards in the chat                                     | MCP Apps UI resource (fine in tech docs)              |
| notifications, Nod tells you                          | MCP Events, webhooks (fine in tech docs)              |
| on Stellar, on your account                           | onchain enforcement (fine once, in the tech part)     |
| Nod pays the network fee                              | relayer, fee sponsorship                              |
| passkey, Face ID, fingerprint                         | WebAuthn, secp256r1                                   |
| pocket                                                | burner, ephemeral account                             |
| claim link                                            | onboarding transaction                                |
| mainnet at trynod.si; testnet at testnet.trynod.si    | an unnamed network                                    |

## Hosts

| Host                                                  | What it is                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [trynod.si](https://trynod.si)                        | the product on Stellar mainnet: open to anyone; USDC only; fund it from any exchange or wallet through your deposit address; connector `https://trynod.si/mcp` |
| [testnet.trynod.si](https://testnet.trynod.si)        | the judges' sandbox: new wallets get 10 testnet USDC; `/sample` runs a sample agent; connector `…/mcp`                                                         |
| `hack-meridian-testnet.kristjan-grm11775.workers.dev` | the old host; redirects to testnet.trynod.si                                                                                                                   |

## Demo beats (one number, the same on both networks)

The sandbox wallet starts with 10 testnet USDC; the founder's mainnet wallet held 9.90 USDC.

| #   | Beat                                                                                                                  | Allowance left |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Connect Claude; the consent page asks for one number: 5 USDC until tomorrow 12:00 UTC; passkey                        | 5.00           |
| 2   | "Buy the market brief": 0.10 USDC over x402, no prompt                                                                | 4.90           |
| 3   | "Send Alice 2 USDC": paid on its own                                                                                  | 2.90           |
| 4   | "Pay Bob 5 USDC for dinner": more than what is left, so it needs your nod; passkey; paid                              | 2.90           |
| 5   | The same request again (same idempotency key): the same receipt; Bob is paid once                                     | 2.90           |
| 6   | "Send Alice 4 USDC": needs your nod; nothing is reserved or spent                                                     | 2.90           |
| 7   | "Send Carol 1 USDC": she has never held USDC; your nod, then her claim link; trustline and payment in one transaction | 2.90           |
| 8   | Revoke: Nod stops signing, your passkey removes the rule, the pocket comes back; the next payment is refused          | gone           |

## Lines for the recording

The film's structure, order and cut are decided with Kristjan after the code lands. These are the words for each beat,
one take per line, so any structure can use them.

| Beat    | Line                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the nod | "Claude wants to pay Bob five dollars for dinner. That's more than I let it spend alone, so it asks me. One passkey tap, and Bob is paid."                      |
| title   | "This is Nod. Small stuff, it just pays. Big stuff needs your nod."                                                                                             |
| why     | "Apps are turning into conversations. My wallet should be in the conversation too: cards in the chat, and a link when it needs me."                             |
| connect | "I add Nod to Claude and set one number. Claude may spend five dollars until tomorrow. My passkey writes that onto my Stellar account. No seed phrase, no XLM." |
| brief   | "Claude buys a market report over x402 for ten cents. It fits the allowance, so nobody asks me. OpenZeppelin's facilitator settles it."                         |
| Alice   | "It pays Alice two dollars on its own. Two ninety left."                                                                                                        |
| repeat  | "Ask twice, pay once."                                                                                                                                          |
| four    | "Four dollars is more than what's left, so it asks me first."                                                                                                   |
| Carol   | "Carol has never held USDC. She accepts the link, and her trustline and the payment land in one transaction."                                                   |
| revoke  | "I revoke Claude. Nod stops signing, my passkey takes the rule off my account, and the leftover comes back. The next payment is refused."                       |
| mainnet | "This is Stellar mainnet, in claude.ai, with my own wallet and real dollars."                                                                                   |
| end     | "Nod. Small stuff, it just pays. Big stuff needs your nod."                                                                                                     |

## Landing page (the app's signed-out home)

1. **Hero.** "Give your AI an allowance." The example wallet plays the beats: Claude may spend 5.00 → 4.90 → 2.90; Bob's
   5.00 needs your nod; the passkey approves it and the allowance stays 2.90.
2. **Why**, three plates: apps become conversations; autonomy needs an allowance; every payment can bring someone on.
3. **How it works**: connect, set an allowance, let it pay.
4. **Why you can trust it**: the limit lives on your account; your passkey approves the payment it shows; revoke any
   time; no seed phrase, no XLM.
5. **Pays people too**: the claim link, trustline and payment in one transaction.
6. **Proof**: the mainnet run first, then the testnet rehearsal and the spikes, each with its stellar.expert link.
7. **Try it** on the testnet sandbox (10 testnet USDC, `/sample`).
8. **Footer**: built with OpenZeppelin smart accounts, Circle USDC, x402, passkeys, Stellar; both hosts; source.

## Deck (PDF, 10 slides, each headline a claim)

| #   | Headline                                                 | Rubric line              |
| --- | -------------------------------------------------------- | ------------------------ |
| 1   | Give your AI an allowance.                               | title                    |
| 2   | Apps are becoming conversations. Wallets have to follow. | User Value & Problem 20% |
| 3   | One number. Inside it, it pays. Past it, it asks.        | what we built            |
| 4   | In the chat: claude.ai, ChatGPT and Goblin.              | Product Design & UX 10%  |
| 5   | The limit lives on your Stellar account.                 | Technical Execution 15%  |
| 6   | Nine building blocks, one wallet.                        | Track Alignment 20%      |
| 7   | Four ideas behind Nod.                                   | Innovation 15%           |
| 8   | Built in one day, live on mainnet by evening.            | Hackathon Progress 10%   |
| 9   | Every AI app is a door.                                  | Market & Ecosystem 10%   |
| 10  | Three minutes, in your own Claude. (both hosts)          | continuation             |

## Next (say "next", never "live")

- Mainnet for what runs on testnet tonight: deposit-first signup with an exchange deposit address, links that create a
  wallet and act as an allowance for one person, contacts the AI adds.
- Recovery passkey and shared wallets; cash-out through a Stellar anchor; no pocket step once facilitators accept
  smart-account payers.

## Open

- Launch posts after submission, from Kristjan's accounts, only with his go.

## Appendix: mentor kit

### 15-second opener

"Apps are turning into conversations, so wallets have to live in the chat. Nod is a Stellar wallet inside Claude. You
give each AI app one number, an allowance. Inside it, the AI pays on its own; past it, your passkey nods. It runs on
mainnet today."

### 45-second walk

"I add Nod to Claude with one URL. The consent page asks me one thing: how much may Claude spend on its own, and until
when. I say five dollars until tomorrow, and my passkey writes that onto my Stellar account as an OpenZeppelin policy.
Claude buys a market report over x402 for ten cents and pays Alice two dollars, with no prompt. Two ninety left. Then
it wants five for Bob's dinner. That's past the allowance, so Claude hands me a link. I open it, see Bob and five
dollars, and tap my passkey. Paid. Carol has never held USDC, so she gets a claim link; her trustline and the payment
land in one transaction. When I revoke Claude, Nod stops signing, my passkey takes the rule off the account and the
pocket comes back. All of that ran on mainnet in claude.ai this evening, with my own wallet."

### Technical answers

- **Where is the limit enforced?** On the account. Each AI app is a context rule on the owner's OpenZeppelin smart
  account: the app's Ed25519 key, OpenZeppelin's spending-limit policy and an expiry. A transfer past what is left fails
  in the account's own auth check (testnet `3daf4b00…`, error `#3221`). Nod also re-simulates in enforcing mode, so an
  over-limit payment never reaches the chain.
- **What if your server is compromised?** The service holds each app's key (encrypted) and the fee-paying relayers.
  The most it could spend for an AI app is the allowance you set, pocket included. It cannot sign with your passkey.
- **Why a pocket?** Hosted x402 facilitators do not take a smart-account payer yet (x402 issue #3158, fix in PR #3860)
  or the policy's extra event (#3352, PR #3399). So each AI app's key also owns a small classic account with sponsored
  reserves, filled from the wallet under the same policy in 1 USDC steps, and pays with the stock x402 client. Both
  transactions are on the receipt. When those PRs merge, the account pays sellers directly and the pocket goes.
- **Do you run a facilitator?** No. x402.org and OpenZeppelin Channels on testnet, OpenZeppelin Channels on mainnet. The
  mainnet market brief settled through Channels (`cb296cc3…`), which also paid that fee.
- **What does one number mean for payments I approve?** The allowance is the only limit. Past it, your passkey approves
  each payment, any amount your balance covers. Approved payments do not use the allowance.
- **Why Stellar?** Native passkey verification, OpenZeppelin's account rules, and CAP-73, which lets a recipient's first
  signature create the USDC trustline alongside the payment. Fees are small enough that Nod pays them: on mainnet the
  payment to Alice cost 0.052 XLM, Bob's 0.0013 XLM, Carol's trustline and payment 0.0021 XLM.
- **Notifications in Claude?** claude.ai and Claude Code do not implement MCP Events yet, so Nod's cards poll there.
  Goblin and ChatGPT take them: a `payment.received` notice arrived by webhook in Goblin (testnet `091942b4…`), and in
  ChatGPT a 1 USDC transfer woke its task within 4 seconds (testnet `c85e7693…`).
- **Is it audited?** No. The account, verifiers and policy are OpenZeppelin's deployed contracts. The account build
  (`1b5f4534…`) predates OpenZeppelin's 0.7.3 release; the advisory fixed there concerns Delegated signers, which Nod
  never uses. Our own contracts, the trust-and-pay router and the testnet deposit router, are small and unaudited.
- **What if a link leaks?** Past the allowance, a link is an allowance for one person: your passkey installs a rule
  for exactly the amount, valid seven days, and the link's key is made in your browser and lives only in the link (Nod
  stores the public key and the rule id). Nod never holds the link key or the funds; a leaked link can take at most the
  amount, once, before it expires. You can take an open link back under Connections → Links; on testnet the account
  refused one stroop more than the amount (`#3221`), a second claim was refused, and a take-back removed the rule
  (`1803a30c…`).
- **How does money get in?** Home → Add money gives a `G…` deposit address any exchange or wallet can pay, any
  amount, no memo; our deposit router sweeps it into your wallet and nowhere else. A new wallet can start from one: the
  account deploys when the first USDC lands. On mainnet a 1 USDC classic payment was swept and the account deployed 83
  seconds later (`7c57d530…`, `57b97375…`). Freighter can also pay the wallet's `C…` address directly.
- **What about ChatGPT?** Nod works in ChatGPT as a developer-mode connector: cards, the nod and events, shown on
  testnet (`88973525…`). It is not listed in ChatGPT's app store, whose policy bars crypto transfers.
- **Recovery?** Not built. A second passkey is the first item after judging.

### Closer

"Small stuff, it just pays. Big stuff needs your nod. Try it on mainnet at trynod.si."
