# Submission: Nod

Deadline **2026-10-26 12:00 UTC** (12:00 Lisbon, 13:00 on the netcup box). Portal: https://app.hackmeridian.com (sign
in with the registered email). Path: **Genesis** (assigned). Thematic track: **Stellar Composed** (the form takes one).
Judges see the video, the deck, the public repository and these answers, after an AI pre-judge reads the site
(`/llms.txt`, `/robots.txt`, `/sitemap.xml` are served). Deck: PDF, PPTX, PPT or HTML up to 20 MiB
(`deck/dist/nod-deck.pdf`). Video: a YouTube or Vimeo link, required. The words come from [PITCH.md](PITCH.md); every
claim below has its proof in the repository.

## Portal form, field by field

Character counts were measured on the text between the field heading and the next heading.

### Project title

Nod

### Tagline (≤ 120 characters; this one: 113)

Small stuff, it just pays. Big stuff needs your nod. A Stellar wallet inside your AI, with one allowance you set.

### Description (Markdown, ≤ 8000 characters; this one: 7837)

**Apps are turning into conversations and agents, so wallets have to follow them into the chat.** Nod is a Stellar
wallet that lives inside the AI you already use: one connector URL in Claude, Goblin, Claude Code or any MCP app, and in
ChatGPT as a developer-mode connector. In hosts that render MCP Apps, Nod's cards appear in the chat; in hosts that take
MCP Events, Nod tells you when money arrives or a payment needs you. You sign up with a passkey and hold USDC, and you
never meet XLM, a seed phrase or a trustline.

Approving every call kills an agent's autonomy, and nobody trusts an AI with the whole balance. So you give each AI app
**one number, an allowance**, say 5 USDC until tomorrow. Inside it, the app pays for APIs over x402 and pays people on
its own. Anything past it needs your passkey, every time, for any amount: the AI hands you a link, and your passkey
signs on Nod's own page, on your phone or your laptop. The allowance is an OpenZeppelin spending-limit policy on your
own Stellar account, so the most Nod's service could ever spend for an AI app is the allowance you set, pocket
included. Someone who has never held USDC gets a claim link, and their trustline and the payment land in one
transaction.

- **Live on Stellar mainnet:** https://trynod.si, the product: open to anyone, USDC only, funded from any exchange or
  wallet through your deposit address, or from another chain. Connector `https://trynod.si/mcp`.
- **Judges' sandbox on testnet:** https://testnet.trynod.si. New wallets get 10 testnet USDC, and `/sample` runs a
  sample agent. Connector `https://testnet.trynod.si/mcp`.

#### Proof on mainnet

The full flow runs on Stellar mainnet at trynod.si, in claude.ai, on the founder's own wallet: an x402 purchase settled
by OpenZeppelin Channels, a payment inside the allowance, one that needed the nod, a claim link that created a
trustline and paid in one transaction, a revoke that removed the rule and swept the pocket.

- x402 market brief, 0.10 USDC: pull into the pocket [`6485e55c`](https://stellar.expert/explorer/public/tx/6485e55cd8f69d51b60f608bdc253d40c3d7ee02f9b86bcccd6cefbeeb08c7bb), settled by OpenZeppelin Channels [`cb296cc3`](https://stellar.expert/explorer/public/tx/cb296cc3a539cfaf966d79fa3662e48e83e3f1fb01fe9be24b767d3c3c8dea58)
- 2 USDC to Alice inside the allowance: [`c8ee8b5a`](https://stellar.expert/explorer/public/tx/c8ee8b5ad7599b9db13a4dd551a918d55ecafc6de2f31c79a61fcc7edb1032cb) · 5 USDC to Bob, past it, approved with the passkey: [`0339b8dd`](https://stellar.expert/explorer/public/tx/0339b8dd088b46d500de425d0afe8707ff6922186ef70070396323f2d3312e4f)
- 1 USDC to Carol, trustline and payment in one transaction: [`1fe4e852`](https://stellar.expert/explorer/public/tx/1fe4e852314ea638ed53ba79acebc60a129b587e0ef80c9b051d434aa01e68c6)
- Revoke: rule removed [`e17e15d5`](https://stellar.expert/explorer/public/tx/e17e15d5efd2f43e883073873ff9d5dc0333ea9dca318cea0f38a5c7678f04c9), pocket swept back; the next payment was refused

#### What works today

- **Passkey wallet, one allowance per AI app.** Face ID creates an OpenZeppelin smart account; connecting an AI app
  and setting its allowance is one step, a context rule with a spending limit and an expiry. Nod pays every fee.
- **Pays for APIs.** The AI buys a 0.10 USDC market brief over x402 with no prompt (4.90 left), settled by a public
  facilitator; on mainnet it also bought Stellar's own x402 demo endpoint.
- **Pays people.** "Send Alice 2 USDC" goes out under the same allowance, signed by the app's own key; 2.90 left.
- **Needs your nod.** "Pay Bob 5 USDC for dinner" is more than the 2.90 left, so it is never signed with the app's key.
  You get a link showing Bob's name and address, the amount and who asked; your passkey signs that payment, and the
  allowance stays 2.90. Ask twice, pay once.
- **Pays people who have never held USDC.** After your nod they get a claim link and sign once: their trustline
  (CAP-73) and the payment land in one transaction.
- **Revoke.** Nod stops signing at once and sweeps the pocket back; one passkey tap removes the allowance from your
  account.
- **Cards and notifications.** Nod's cards and the nod run live in Goblin, claude.ai and ChatGPT; notifications (MCP
  Events) arrive in Goblin and ChatGPT's Work chats, and claude.ai's cards poll.
- **Sign up with a deposit, on mainnet.** Start with nothing onchain and a `G…` address any exchange or wallet can pay,
  no memo; it is swept into your wallet and the account deploys ([`7c57d530`](https://stellar.expert/explorer/public/tx/7c57d530372b32fe07aac7ea9220380ff52ce54a329518ff838179357329d7af)).
- **Top up from any chain, on mainnet.** Add money → From another chain, or ask Claude: NEAR Intents' 1Click pays
  USDC to your deposit address. Dry-run quotes so far: 5 USDC on Base → 4.98 on Stellar in about 50 s.

Live on testnet:

- **Pay someone who is not on Stellar.** Claude makes a claim link for a name; Jan opened it with no wallet, created
  one with a passkey, and the USDC landed in it ([`eb9def8c`](https://stellar.expert/explorer/testnet/tx/eb9def8cebc58e8ad0f659e70123ab12449cc91184a243172825bd1f25dd4f1e)).
- **Past the allowance, a link that is an allowance for one person.** Your one passkey tap installs a rule for
  exactly the amount, for seven days; its key is made in your browser and lives only in the link. Nod never holds the
  link key or the funds; a leaked link can take at most the amount, once, before it expires
  ([`fd54c526`](https://stellar.expert/explorer/testnet/tx/fd54c5267cea3afe68beb528afd44e385695c9b0e21f48c591b1588062fd77a6)).
- **Contacts from the chat.** Claude adds contacts; the first payment to one it added needs your nod
  ([`b5efd05d`](https://stellar.expert/explorer/testnet/tx/b5efd05d326c936908785b99050b7719d4b0f341923fd24ae0c56e5a2dcca282)).

#### How it uses Stellar

- OpenZeppelin smart account and spending-limit policy: your passkey as admin, one rule per AI app with its allowance.
- WebAuthn (secp256r1) and Ed25519 verifiers: your passkey and each AI app's own key.
- Circle USDC through the Stellar Asset Contract.
- SAC `trust` (CAP-73) and our trust-and-pay router: trustline and transfer in one invocation.
- SAC `approve` and our deposit router: deposit addresses swept into the wallet.
- x402 through x402.org and OpenZeppelin Channels, never a facilitator of ours.
- Sponsored reserves and fee-paying relayers (the owner holds no XLM); SEP-1 `stellar.toml` with `home_domain`.

Hosted x402 facilitators do not take smart-account payers yet, so each AI app's key also owns a small pocket account,
filled from your wallet under the same policy in 1 USDC steps. Both transactions are on the receipt.

#### Proof on testnet

One rehearsal on the live site passed acceptance tests 1, 2 and 4–9; test 3, a forced over-limit transfer, cannot be
sent through MCP by design and is proven onchain in spike S1 ([`3daf4b00`](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a)).
Its seven transactions on release `5253df0`: [`run.json`](https://github.com/grmkris/hack-meridian-2026/blob/main/evidence/demo/2026-10-25T19-14-24-616Z/run.json).

#### Try it in three minutes (testnet sandbox)

Add `https://testnet.trynod.si/mcp` as a custom connector in Claude, create a passkey wallet on the page that opens and
set a 5 USDC allowance. Then ask: "Buy the market brief", "Send Alice 2 USDC", "Pay Bob 5 USDC for dinner" (more than
the 2.90 left, so it needs your nod). Full steps and more to try: `evidence/JUDGE-TEST-PATH.md`. No Claude at hand?
https://testnet.trynod.si/sample runs a sample agent on Nod's own demo wallet, with explorer links.

#### Built at HackMeridian

Spikes first, then the product; mainnet the same evening. Every commit is on `main` from 25 October.

### Problem solved

People who use AI assistants want them to finish tasks that cost money: buy a paid API result, pay a friend back, cover
a small bill. Today they hand the assistant a card or a private key, which gives it everything, or they approve every
payment themselves, which defeats the point of an agent. Sellers of paid APIs feel it too: x402 lets agents pay per
call, but Stellar's docs note "there is no policy layer for x402 on Stellar today", so few owners let an agent hold
money. Nod gives each AI app one allowance on the owner's Stellar account, enforced by OpenZeppelin's spending-limit
policy on that account. Inside it the app pays on its own; anything past it comes back as a link the owner approves
with a passkey, every time, for any amount. The wallet lives where the agent works, in the chat, with cards and
notifications, and a person who has never held USDC can be paid through a claim link.

### Challenges

- **Hosted x402 facilitators reject smart-account payers.** We would not run our own facilitator: a wallet that only
  works with its own settlement service is not interoperable. Instead each AI app's key owns a small sponsored pocket
  account, filled from the wallet under the onchain policy in 1 USDC steps, and pays as a plain account through x402.org
  or OpenZeppelin Channels. Upstream fixes are open (x402 PRs #3399 and #3860).
- **Making "5 USDC until tomorrow" mean exactly that.** OpenZeppelin's policy uses a rolling window, so we size the window
  to the allowance's lifetime plus a margin and add an expiry. We tested the boundary: exactly 5.0 passes, one stroop
  more is rejected.
- **One number.** We tried a second threshold for payments that need your nod; the consent and approval screens then
  showed three numbers, which was confusing. The allowance is now the only number you set.
- **Soroban authorization details.** Signed auth entries must be re-simulated in enforcing mode before submission; the
  two-signer trustline call needs a non-root recording simulation first; passkey signatures cover the auth digest, so an
  approval cannot be redirected.
- **Exchanges cannot pay a contract account.** A Nod wallet is a `C…` address. Our deposit router binds a sponsored
  `G…` deposit address to one wallet so that anyone can sweep what arrives into it and nowhere else. Installing a rule
  on the account would have needed the owner's passkey, so the bound lives in the router. Proven on mainnet: a
  stranger-style signup funded by a 1 USDC payment, swept and deployed in 83 seconds. The same address is what NEAR
  Intents' 1Click pays when you top up from another chain.
- **Testnet storage rent spiked during the day**, from about 47× normal to over 200×, and one pocket pull cost 91 XLM in
  fees. We size fee ceilings from the enforcing simulation and pull in 1 USDC steps; because we integrated two public
  facilitators, the seller moved to OpenZeppelin Channels when x402.org's fee cap fell below the settlement cost. On
  mainnet a payment cost Nod between 0.001 and 0.05 XLM.
- **The trustline needs the recipient.** CAP-73's `trust` requires the recipient's own signature and 0.5 XLM of reserve,
  so the claim link is something the recipient signs.
- **One builder, many agents, one branch.** Parallel Claude Code sessions built the spikes, the product and the copy on
  `main` with disjoint ownership, small commits and evidence for every claim.

### What's next

- **Mainnet for what runs on testnet tonight.** Links that create a wallet for someone with nothing (and act as an
  allowance for that one person), and contacts the AI adds.
- **A funded top-up from another chain** (quotes run today), then **sending out** to other chains through 1Click with a
  muxed address, since its Stellar deposit takes a numeric memo.
- **Recovery and shared wallets.** A second passkey or a guardian, and wallets two people own.
- **Cash-out** to a bank through a Stellar anchor.
- **No pocket step** once x402 facilitators accept smart-account payers.
- **Hardening from our own code audit:** a watcher that settles payments whose outcome is unknown, cleanup of expired
  allowances, and the account build moved to OpenZeppelin's current release.

### Repository link

https://github.com/grmkris/hack-meridian-2026

### Demo link

https://trynod.si

### Video link

YouTube (unlisted) link, uploaded by Kristjan after recording.

### Tech stack (comma-separated, ≤ 25; this one: 25)

Rust, Soroban, soroban-sdk, Stellar SDK, stellar-cli, OpenZeppelin Stellar contracts, Stellar Asset Contract, USDC,
x402, OpenZeppelin Channels, WebAuthn passkeys, Model Context Protocol, MCP Apps, MCP Events, OAuth 2.1, TypeScript,
Effect, Foldkit, Cloudflare Workers, Durable Objects, D1, Alchemy, Bun, NEAR Intents, Tailwind CSS

### Prior work disclosure

Everything in this repository was written during HackMeridian; the git history starts on 25 October 2026. Used as-is
from others: OpenZeppelin's deployed Stellar smart-account, verifier and spending-limit contracts; Circle's USDC; the
x402 libraries and the hosted facilitators x402.org and OpenZeppelin Channels; agent skills vendored with source,
commit and licence in `.agents/skills/sources.json`. From Kristjan's earlier projects: repository conventions and agent
tooling. The MCP Events wire (schemas, webhooks, delivery, journal, policy) was ported from Kristjan's own myapps
codebase and the 2026-07-28 MCP lane is modelled on his agent-jobs server; Goblin, one of the three hosts shown, is
Kristjan's own MCP host. Kristjan built Froggy at ETHOnline 2026, an agent wallet on Base and Hedera whose limits were
enforced by its own server; no Froggy code is used here, and Nod moves the limit onto the account itself.

### AI tooling note

Claude Code wrote most of the code and docs, run as parallel Claude Opus 5.5 and Fable sessions with separate jobs: an
orchestrator (spec, spikes, build plan, deploys), the site, the wallet service, the Stellar chain package, MCP Apps and
Events, deposits, the demo seller and rehearsal runner, and the pitch, README, deck and landing copy. Every session
followed the rules in `AGENTS.md` and committed small changes to `main`. Raven, Stellar's MCP server, and Stellar's
developer skills supplied documentation and ecosystem research, including prior hackathon entries. Gemini, through the
Antigravity CLI, reviewed the copy. Kristjan set the scope and made the product decisions (no facilitator of our own,
Claude as the first host, one number, mainnet as the product, the name, the demo amounts), tested the flows, and ran
the mainnet flow in claude.ai with his own wallet and passkey. Every onchain claim was executed on Stellar and links to
stellar.expert.

## Judge test path

Sandbox: https://testnet.trynod.si, MCP connector `https://testnet.trynod.si/mcp`; a fresh wallet is funded with 10
testnet USDC. Steps for a judge: `evidence/JUDGE-TEST-PATH.md` (Claude connector first). Reference run with explorer
links: `evidence/demo/2026-10-25T19-14-24-616Z/`. The product itself is on mainnet at https://trynod.si.
