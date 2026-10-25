# Submission: Nod

Deadline **2026-10-26 12:00 UTC** (12:00 Lisbon, 13:00 on the netcup box). Portal: https://app.hackmeridian.com (sign
in with the registered email). Path: **Genesis** (assigned). Thematic track: **Stellar Composed** (the form takes one). Target submit time **11:00 UTC**, then re-check every link in a private
window. Source for rules and rubric: `docs/research/hackathon-and-ecosystem.md`.

## Fill in from the portal (Kristjan, 15 minutes, as early as possible)

| Field                              | Value                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| Demo video                         | hosted on YouTube or Vimeo; length limit not stated on the form (plan ≤ 3 min) |
| Pitch deck format                  | PDF, PPTX, PPT or HTML; the portal offers a template                           |
| Submission questions               | pasted by Kristjan; field drafts below in "Portal form, field by field" (a3)   |
| Team members and emails registered | UNVERIFIED                                                                     |
| Track selection                    | ONE thematic track: Stellar Composed (Genesis path is assigned)                |

## Checklist

| #   | Item                                                                                                                                                                                 | Owner                        | When (UTC)                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------- |
| 0   | Portal fields above copied into this file                                                                                                                                            | Kristjan                     | done 14:00                       |
| 0b  | `/llms.txt`, `/robots.txt`, `/sitemap.xml` served by the live site (an AI pre-judges before humans)                                                                                  | a3 writes, B places          | 15:00                            |
| 0c  | README with the required headings: summary, problem, setup, installation, environment variables, demo instructions, architecture (assets, contract ids, wallets, integrations, APIs) | a3, env list from A1         | 18:00 draft, 08:00 final         |
| 1   | Public repo `grmkris/hack-meridian-2026` pushed; small commits keep landing on `main`                                                                                                | foundation session, then all | today                            |
| 2   | README: problem, how it works, specs, architecture, testnet ids, explorer links, run, judge test, prior work, AI attribution                                                         | docs agent                   | 17:00–20:00 draft, 08:00 final   |
| 3   | Demo video: script below, screen recording with voice, upload                                                                                                                        | Kristjan + agent             | record by 07:00, upload by 09:30 |
| 4   | Pitch deck: one slide per rubric line (below), PDF                                                                                                                                   | docs agent                   | skeleton 18:00, final 09:00      |
| 5   | Submission answers drafted below, pasted into the form                                                                                                                               | Kristjan                     | 10:00–10:30                      |
| 6   | Judge-testable deployment: URL, funded testnet path, a test connection the judge can use                                                                                             | build                        | verified 09:00                   |
| 7   | Submit; re-check links privately                                                                                                                                                     | Kristjan                     | 11:00                            |

## Deck, demo video and words

The deck outline (one slide per rubric line), the demo video's voice-over lines and shot list, the promo film brief, the
landing page sections and the vocabulary live in [PITCH.md](PITCH.md). The product is presented as **Nod**. Fallbacks: if
the trustline beat is not green on the real service by 06:00 UTC, cut it and extend the revoke beat; if Claude's
connector flow fails on the day, record in Claude Code (proven in S4).

## Portal form, field by field

Copied from app.hackmeridian.com on 2026-10-25. Builder track **Genesis** is assigned. The form takes **one** thematic
track: **Stellar Composed**. The SAC trustline feature (CAP-73) stays in the product and the answers as a protocol
feature we use, not as a second track. Judging includes "AI-assisted pre-judging, where humans make every decision",
and the demo site should serve `llms.txt`, `robots.txt` and `sitemap.xml`. Deck: PDF, PPTX, PPT or HTML up to 20 MiB
(the portal has a template). Video: a YouTube or Vimeo link, required.

### Project title

Nod

### Tagline (≤ 120 characters)

A Stellar wallet your AI spends from inside an onchain allowance. Small stuff, it just pays. Big stuff needs your nod.

### Description (Markdown, ≤ 8000 characters)

**Nod gives your AI an allowance.** It is a Stellar wallet you add to Claude, or any MCP app, with one connector URL.
Each AI app gets its own allowance, for example 5 USDC until tomorrow, which your passkey signs onto your Stellar
account. Inside it, the app pays for APIs over x402 and pays your contacts on its own. Anything bigger comes back to you
as a link, and one passkey tap approves that exact recipient and amount. The limit is an OpenZeppelin spending-limit
policy on your account, not a setting on our server: even if our server were compromised, the most it could spend for an
AI app is what you allowed.

**Live on Stellar testnet:** https://hack-meridian-testnet.kristjan-grm11775.workers.dev · connector `https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp`

#### What works today

- **Passkey wallet.** Face ID or a fingerprint creates an OpenZeppelin smart account. No seed phrase; you never need XLM,
  because Nod pays the network fees. New wallets get 10 testnet USDC so judges can try it.
- **An allowance per AI app.** Connecting Claude over OAuth and approving its allowance is one step. Each allowance is a
  context rule on your account with a spending limit and an expiry.
- **Pays for APIs.** Claude buys a 0.10 USDC market brief from an x402 seller, settled by the public x402.org
  facilitator. No prompt.
- **Pays people.** "Send Alice 2 USDC" goes out under the same allowance, signed by Claude's own key.
- **Needs your nod.** "Pay Bob 20 USDC for dinner" is more than the 2.90 left, so it is never signed with Claude's key.
  You get a link showing Bob's name and address, the amount and who asked; your passkey signs exactly that.
- **Ask twice, pay once.** A repeated request returns the same receipt.
- **Pays people who have never held USDC.** Carol has no trustline: she signs a claim link once, and her trustline and
  the 5 USDC land in one transaction.
- **Revoke.** Nod stops at once, the rule is removed from your account and the leftover balance is swept back.

#### How it uses Stellar (what it composes)

| Building block                                 | Role in Nod                                                                          | Testnet id           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------- |
| OpenZeppelin smart account                     | one contract account per wallet; passkey admin; one context rule per AI app          | WASM `1b5f4534…785a` |
| OpenZeppelin spending-limit policy             | the allowance: N USDC until T, enforced by the account                               | `CABXBYJN…TIP5G`     |
| WebAuthn verifier (secp256r1 host function)    | your passkey signs approvals and allowance changes                                   | `CC7EKIHQ…IOM3F`     |
| Ed25519 verifier                               | each AI app's own key                                                                | `CAAVTMCB…HKN4`      |
| Circle USDC through the Stellar Asset Contract | the money, as a SEP-41 token                                                         | `CBIELTK6…DAMA`      |
| SAC `trust` (CAP-73) + our router              | trustline and transfer in one invocation for the claim link                          | `CCLFB4I4…PGN4`      |
| x402 on `stellar:testnet`                      | paid APIs, settled by x402.org or OpenZeppelin Channels (never a facilitator we run) |                      |
| Sponsored reserves                             | each AI app's small payer account holds 0 XLM                                        |                      |
| Relayer as transaction source                  | Nod pays every fee; the owner holds no XLM                                           | `GBGNYETY…BPT6`      |
| Built-in DEX                                   | the paid market brief reads the XLM/USDC order book                                  |                      |

Hosted x402 facilitators do not accept smart-account payers yet, so each AI app's key also owns a small classic account
that it fills from your wallet under the same policy, then pays from with the stock x402 client (the pocket model). Both
transactions appear on the receipt.

#### Proof on testnet

- Wallet created through the product: [`CAKADCRB…SDIS`](https://stellar.expert/explorer/testnet/contract/CAKADCRBDPEYNNFVNQUWIMPUY53XP7DJUO6DXNNJAHJDIK5EWFSDSDIS)
- x402 purchase: pull into the pocket under the policy [`646d95c9`](https://stellar.expert/explorer/testnet/tx/646d95c918bc43e1ea22f8ffc6efd48b197344d3add94599b2e40c1248a62945), settlement by x402.org [`1c680612`](https://stellar.expert/explorer/testnet/tx/1c6806128d7020f4fe4aa4906c8d0158cc403dd3e1c38ba9988f649442138a19)
- 20 USDC dinner approved with the passkey: [`8f9e79cb`](https://stellar.expert/explorer/testnet/tx/8f9e79cb0df7f06dd7b813988a5b6d71ad5afb32ed57e306c108303b74d44a9f)
- Carol's trustline and 5 USDC in one transaction: [`8457e9cb`](https://stellar.expert/explorer/testnet/tx/8457e9cb67895e86155535a37b64308a60bfb3112c6050b60049537860536bf1)
- An over-allowance transfer forced onchain is rejected by the account: [`3daf4b00`](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a)

#### Try it in three minutes

Add `https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp` as a custom connector in Claude, create a passkey wallet on the page that opens, approve the 5 USDC
allowance, then ask: "Buy the market brief", "Send Alice 2 USDC", "Pay Bob 20 USDC for dinner". Full steps:
`evidence/JUDGE-TEST-PATH.md` in the repository.

#### Built at HackMeridian

Research and pinned versions, then five time-boxed spikes that proved every risky part on testnet with transaction
hashes, then the product: a Cloudflare Worker (Effect, OAuth 2.1, MCP), a Foldkit site and a Stellar chain package.
Every commit is on `main` from 25 October.

### Problem solved

People who use AI assistants (Claude today, any MCP app tomorrow) want them to finish tasks that cost money: buy a paid
API result, pay a friend back, cover a small bill. Today they hand over a card or a private key, which gives the
assistant everything, or they make every payment themselves, which defeats the point. Sellers of paid APIs feel it too:
x402 lets agents pay per call, but Stellar's docs note "there is no policy layer for x402 on Stellar today", so few
owners let an agent hold money. Nod gives each AI app its own allowance on the owner's Stellar account, enforced by
OpenZeppelin's spending-limit policy rather than by our server. Inside it the app pays on its own; anything bigger comes
back as a link the owner approves with one passkey tap, for that exact recipient and amount. No seed phrase, no XLM, and
revoking takes effect at once.

### Challenges

- **Hosted x402 facilitators reject smart-account payers.** We would not run our own facilitator, because a wallet that
  only works with its own settlement service is not interoperable. Instead each AI app's key owns a small sponsored
  account, pulls exactly what a purchase needs from the wallet under the onchain policy, and pays as a plain account
  through x402.org or OpenZeppelin Channels.
- **Making "5 USDC until tomorrow" mean exactly that.** OpenZeppelin's policy uses a rolling window, so we size the window
  to the allowance's lifetime plus a margin and add an expiry. We tested the boundary: exactly 5.0 passes, one stroop
  more is rejected.
- **Soroban authorization details.** Signed auth entries must be re-simulated in enforcing mode before submission; the
  two-signer trustline call needs a non-root recording simulation first; passkey signatures cover the exact auth digest,
  so an approval cannot be redirected.
- **Testnet storage rent at about 50× normal.** The first payment under a new allowance cost 11–17 XLM. We size fee
  ceilings from the enforcing simulation and pull in 1 USDC steps, which cut relayer cost per purchase from 1.69 to 0.56
  XLM. At mainnet rent the whole allowance lifecycle costs about 0.6 XLM.
- **Keeping the demo alive through judging.** The shared OpenZeppelin policy contract on testnet would have expired on 27
  October; we extended the shared contracts to mid-November.
- **The trustline needs the recipient.** CAP-73's `trust` requires the recipient's own signature and 0.5 XLM of reserve,
  so onboarding is a claim link the recipient signs, never silent.
- **One builder, many agents, one branch.** Parallel Claude Code sessions built the spikes and the product on `main` with
  disjoint ownership, small commits and evidence for every claim.

### What's next

- **Mainnet pilot.** A read-only check found every contract we use already on mainnet with identical WASM except our
  920-byte router; OpenZeppelin Channels settles on mainnet; a full allowance lifecycle costs about 0.6 XLM.
- **Recovery and shared wallets.** A second passkey or a guardian, and wallets two people own.
- **Cash-out.** Let the people Nod pays withdraw to a bank through a Stellar anchor.
- **Finer allowances.** Task budgets inside an allowance, merchant allowlists, per-payment caps, payment requests and bill
  splits.
- **Agent-to-agent escrow** with an existing Stellar escrow protocol.
- **No pocket step** once x402 facilitators accept smart-account payers (x402 PRs #3399 and #3860).

### Repository link

https://github.com/grmkris/hack-meridian-2026

### Demo link

https://hack-meridian-testnet.kristjan-grm11775.workers.dev

### Video link

YouTube (unlisted) link, uploaded by Kristjan after recording.

### Tech stack (comma-separated, ≤ 25)

Rust, Soroban, soroban-sdk, Stellar SDK, stellar-cli, OpenZeppelin Stellar contracts, Stellar Asset Contract, USDC,
x402, OpenZeppelin Channels, WebAuthn passkeys, TypeScript, Effect, Foldkit, Cloudflare Workers, Durable Objects, D1,
Alchemy, Bun, Model Context Protocol, OAuth 2.1, Tailwind CSS, Vite, Vitest

### Prior work disclosure (needs Kristjan's confirmation)

Everything in this repository was written during HackMeridian; the git history starts on 25 October 2026. Used as-is
from others: OpenZeppelin's deployed Stellar smart-account, verifier and spending-limit contracts; Circle's testnet USDC;
the x402 libraries and the hosted facilitators x402.org and OpenZeppelin Channels; agent skills vendored with source,
commit and licence in `.agents/skills/sources.json`. From Kristjan's earlier projects: repository conventions and agent
tooling. **[Kristjan to confirm or cut]** Kristjan built Froggy at ETHOnline 2026, an agent wallet on Base and Hedera
whose limits were enforced by its own server; no Froggy code is used here, and Nod moves the limit onto the account
itself.

### AI tooling note

Claude Code (Claude Opus 5.5) wrote most of the code and docs, run as parallel sessions with separate jobs: an
orchestrator (spec, five spikes, build plan), the site, the wallet service, the Stellar chain package, the demo seller
and rehearsal runner, and the pitch, README and landing copy. Every session followed the rules in `AGENTS.md` and
committed small changes to `main`. Raven, Stellar's MCP server, and Stellar's developer skills supplied documentation and
ecosystem research, including prior hackathon entries. Gemini 3.8 Flash in the Antigravity CLI, with the humanizer
skill, reviewed copy. Kristjan set the scope, made the product decisions (no facilitator of our own, Claude as the host,
the name, the demo amounts), tested the flows and recorded the voice-over. Every onchain claim was executed on Stellar
testnet and links to stellar.expert.

## Judge test path

Live since 13:43 UTC: site https://hack-meridian-testnet.kristjan-grm11775.workers.dev, MCP connector
https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp. Steps for a judge: `evidence/JUDGE-TEST-PATH.md` (Claude
connector first). A fresh wallet is auto-funded with 10 testnet USDC. Reference run with explorer links:
`evidence/demo/2026-10-25T13-38-30-890Z/`.
