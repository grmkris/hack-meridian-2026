# Pitch: Nod

Status: v0, 2026-10-25 13:05 UTC. Owner: session `hack-meridian-2026-a3` (name, pitch, landing copy, deck outline, demo
and promo video). Product facts come from `docs/SPEC.md` and the evidence from `docs/spikes/*.md`; this file decides
only the words. Every user-facing surface (app, landing page, README, deck, video, answers) uses the words here.

## Name

**Nod** (Kristjan, 2026-10-25 13:00 UTC). The repository stays `hack-meridian-2026`; the working name
`stellarmcpwallet` leaves every user-facing surface. Write it **Nod** in prose and **nod** in the wordmark.

- Tagline: **Small stuff, it just pays. Big stuff needs your nod.**
- Product line: **Give your AI an allowance.**
- Category line, for people who need one: _a Stellar wallet your AI can spend from._

## The problem

AI assistants can research, plan and shop. When one has to pay, you have two options: hand it everything (a card, a key)
or do the payment yourself. Stellar's own docs say it plainly: "there is no policy layer for x402 on Stellar today."

## What Nod is, in 30 seconds

> AI assistants can research, book and shop. When they need to pay, you hand over your card or do it yourself. Nod is a
> Stellar wallet you add to Claude in one click. Give each AI app an allowance, say five dollars until tomorrow, and it
> pays for APIs and pays your friends on its own. Anything bigger comes to your phone, and one passkey tap approves that
> exact payment. The allowance is an OpenZeppelin policy on your Stellar account, not a setting on our server: even if
> our server were compromised, the most it could spend is what you allowed.

The last sentence is accurate: the service holds only the connection key, and the account's spending-limit policy caps
that key at N until T (S1: exactly 5.0 passed, one stroop over was rejected).

## Three messages, repeated everywhere

1. **It lives in the AI you already use.** One connector URL in Claude; any MCP client works. Not an SDK.
2. **Too big? It asks you.** An over-allowance payment becomes a link your passkey signs for that exact recipient and
   amount, not an error.
3. **The limit lives on Stellar.** OpenZeppelin's smart account and spending-limit policy enforce it; x402 sellers are
   paid through public facilitators (x402.org, OpenZeppelin Channels), not one we run.

Bonus, a Stellar protocol feature (CAP-73, SAC `trust`): **it pays people who have never held USDC.** Their trustline and the payment land in one
transaction after they sign once.

## Why this is not another agent wallet

At least a dozen entries at Stellar Hacks: Agents (April 2026, 249 submissions) built agent wallets with spending
limits; none placed. The placed projects had a concrete user and reached the real world (real cards, a marketplace, paid
APIs, seller tooling). HackMeridian's Composed track names "Agents that spend" as its first example, so expect
look-alikes here too. Nod's first 15 seconds must show what the others did not have:

| Typical agent wallet                 | Nod                                                           |
| ------------------------------------ | ------------------------------------------------------------- |
| SDK or contract for agent developers | a connector a person adds to Claude                           |
| over the limit = blocked             | over the allowance = a passkey approval for the exact payment |
| its own policy contract              | OpenZeppelin's audited account and policy, no budget contract |
| its own payment path                 | stock x402 through public facilitators (the pocket model)     |
| pays APIs                            | pays APIs and people, including people with no trustline      |

## Proof points we can say out loud (all testnet, all with hashes in `docs/spikes/`)

- A 5 USDC allowance spent exactly 5.0; one stroop more was rejected (S1).
- Expired and revoked allowances are refused with distinct errors; the owner's own payments leave the allowance untouched
  (S1).
- A paid API bought over x402 through x402.org and OpenZeppelin Channels from a policy-bound account (S2, S5).
- An exhausted allowance is refused before any facilitator is contacted; a repeated request pays once (S5).
- A recipient with no USDC trustline gets the trustline and the payment in one transaction (S3).
- Connected live from Claude Code over OAuth (S4).

Never claim: mainnet (until a mainnet transaction exists; if one does, it becomes the headline), CCTP, a facilitator of
our own, ChatGPT support, "pay any address silently".

## Vocabulary

| Say                                 | Not                                               |
| ----------------------------------- | ------------------------------------------------- |
| allowance                           | grant, budget rule, context rule, session key     |
| asks you / needs your nod / approve | owner lane, escalation, requires_approval         |
| AI app, Claude                      | MCP client, connection, host (fine in tech docs)  |
| on Stellar, on your account         | onchain enforcement (fine once, in the tech part) |
| Nod pays the network fee            | relayer, fee sponsorship                          |
| passkey, Face ID, fingerprint       | WebAuthn, secp256r1                               |
| testnet (always visible)            | hiding the network                                |

## Landing page (the app's signed-out home)

Lives inside the web app (Kristjan, 13:00 UTC). Sections, top to bottom:

1. **Hero.** "Give your AI an allowance." Sub: "Nod is a Stellar wallet you add to Claude. Small payments go through on
   their own, inside the allowance you set. Anything bigger waits for your nod." Actions: **Create your wallet**
   (passkey) and **Add to Claude** (copies the connector URL). Visual: the two-number card (wallet 30.00 USDC / Claude
   may spend 5.00) beside a chat line and a phone approval.
2. **How it works**, three steps. _Connect_: add Nod to Claude or any MCP app. _Set an allowance_: "5 USDC until
   tomorrow", signed with your passkey and written to your Stellar account. _Let it pay_: paid APIs over x402, friends by
   name; bigger asks come to your phone.
3. **Why you can trust it.** The limit lives on Stellar, not on our server · Your passkey approves the exact recipient
   and amount · Revoke any time, instantly and on Stellar · No seed phrase, no gas: Nod pays the network fee.
4. **Pays people too.** "Even people who have never held USDC": a claim link, then the trustline and the payment in one
   transaction.
5. **Proof.** Live stellar.expert links: a payment inside the allowance, an approved payment, an over-limit transfer
   rejected by the account, a trustline-plus-payment. Filled from `evidence/` after the first testnet run.
6. **Try it in 3 minutes** (for judges): add the connector, create a passkey wallet (auto-funded with 10 testnet USDC),
   ask Claude to buy the market brief, pay Alice, then ask for 20 USDC for dinner with Bob.
7. **Built with** OpenZeppelin smart accounts · Circle USDC · x402 · passkeys · Stellar. HackMeridian 2026, Stellar
   Composed track. GitHub link. Testnet notice.

## Deck (PDF, 10 slides, each headline a claim)

| #   | Headline                                                    | Rubric line              |
| --- | ----------------------------------------------------------- | ------------------------ |
| 1   | Give your AI an allowance. (two-number card)                | title                    |
| 2   | Your AI can do everything except pay safely.                | User Value & Problem 20% |
| 3   | One connector, two lanes: it pays, or it asks you.          | what we built            |
| 4   | Demo stills: buy, pay Alice, 20 asks, approve, revoke.      | Product Design & UX 10%  |
| 5   | The limit lives on Stellar, not on our server.              | Technical Execution 15%  |
| 6   | Six building blocks, composed; a trustline through the SAC. | Track Alignment 20%      |
| 7   | New: the pocket model, connect = allowance, ask not reject. | Innovation 15%           |
| 8   | Built this weekend: research → 5 spikes → product.          | Hackathon Progress 10%   |
| 9   | Every AI app is a door; Stellar's x402 sellers need buyers. | Market & Ecosystem 10%   |
| 10  | Try it in 3 minutes, and what's next.                       | continuation             |

## Demo amounts (Kristjan, 2026-10-25; identical on testnet and mainnet)

Wallet starts at 30 USDC; the AI app's allowance is 5 USDC; it buys a 0.10 USDC API result and pays Alice 2 USDC on its
own (2.90 left); the 20 USDC dinner for Bob needs his nod; asking twice pays once; 4 USDC is more than the 2.90 left, so
it comes back to him; Carol, who has never held USDC, gets 5 USDC through a claim link she signs; then revoke.

## Demo video (≤ 3 min; Kristjan's voice, cut by this session)

Kristjan records each line below as its own take (quiet room, phone or USB mic, one take per line, a second of silence
either side). Picture is cut to the voice from screen captures of the real flow, with captions, chapter marks, a quiet
music bed and an end card. The cold open is the approval: it is the moment no other entry has.

| #   | Picture                                                                        | Line                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude: "Pay Bob 20 USDC for dinner" → "needs your nod" → phone, Face ID, Paid | "My AI just asked me for twenty dollars. One tap, and it's paid: exactly to Bob, exactly twenty."                                                          |
| 2   | Title: nod. "Small stuff, it just pays. Big stuff needs your nod."             | "This is Nod, a Stellar wallet your AI can spend from, inside an allowance you set."                                                                       |
| 3   | Add the connector in Claude → consent page → passkey                           | "I add Nod to Claude. My passkey creates the wallet and signs one rule on Stellar: Claude may spend five dollars, until tomorrow. No seed phrase, no XLM." |
| 4   | Home: 30.00 USDC wallet, 5.00 Claude may spend                                 | "Two numbers that never blur. The wallet holds thirty. Claude may spend five."                                                                             |
| 5   | "Buy the market brief" → content + receipt, 4.90 left                          | "Claude buys a paid market report over x402. No prompt, because it fits the allowance. A public facilitator settles it."                                   |
| 6   | "Send Alice 2 USDC" → receipt, 2.90 left, stellar.expert                       | "It pays Alice two dollars, signed by Claude's own key and checked by an OpenZeppelin policy on my account. Nod pays the fee."                             |
| 7   | Same request again → same receipt; "Send 4 USDC" → asks                        | "Ask twice, pay once. And four dollars is more than what's left, so it comes to me instead of failing."                                                    |
| 8   | Forced over-limit transfer → rejected on stellar.expert                        | "Even if our server tried, the account itself rejects anything over the limit."                                                                            |
| 9   | "Send Carol 5 USDC" → claim link → Carol signs → one transaction               | "Carol has never held USDC. She signs once, and her trustline and the payment land in the same transaction."                                               |
| 10  | Revoke → next payment refused                                                  | "I revoke Claude. The next payment is refused, and the rule is gone from my account."                                                                      |
| 11  | End card: nod · repo · Stellar Composed                                        | "Nod. Give your AI an allowance, and keep the last word."                                                                                                  |

## Promo film (20–30 s, no voice, captions, 16:9 and 9:16)

For the landing hero, README GIF, launch post and deck slide 1. Kinetic type over real UI: "Your AI can shop." → "Paying
is the scary part." → $0.10 report, paid · $2 to Alice, paid · $20 to Bob → "needs your nod" → Face ID → paid →
"The limit lives on Stellar." → nod wordmark. Built from Playwright captures of the real app, HyperFrames for type and
motion, and the caption, chapter and music pipeline from `~/code/goblin-videos/demo-cut`.

## Open

- Prior-work disclosure for the README (Kristjan, later).
- Mainnet: if a real mainnet payment exists before 08:00 UTC, it leads the landing page, slide 1 and the video's end
  card.
- Launch posts after submission, from Kristjan's accounts, only with his go.
