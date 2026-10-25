# Spec: Nod, a Stellar wallet with budgets for your AI (repo: hack-meridian-2026)

Status: draft v0, 2026-10-25 11:30 UTC. Scope frozen for HackMeridian 2026. Submission deadline **Mon 26 Oct 2026
12:00 Lisbon = 12:00 UTC** (EU daylight time ended 25 Oct; this box runs CET = UTC+1, so 13:00 box time). Judging is
asynchronous: demo video, pitch deck, GitHub repo, written answers. Finalists pitch live Wed 28 Oct.

Product name: **Nod** (Kristjan, 2026-10-25 13:00 UTC; words in `docs/PITCH.md`). Engineering name in code and package ids stays as is; repo: grmkris/hack-meridian-2026.

## One line

> Your agent can pay people and buy services. You decide how much it can spend.

A passkey-owned Stellar smart account that AI connections (ChatGPT, Claude, Goblin, any MCP client) spend from within
budgets the owner sets. Small payments and paid API calls go through on their own inside a visible, expiring onchain
allowance. Anything bigger comes back to the owner as an approval link that their passkey signs for the exact recipient,
asset and amount.

## The product is the two lanes

| Lane           | Who signs                                  | What it may do                                                               | Enforced by                                                                                              |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Autonomous** | a dedicated Ed25519 key per MCP connection | transfer USDC (people or x402 sellers) up to the grant's total, until expiry | onchain: OpenZeppelin context rule + spending-limit policy + `valid_until`; offchain: intent reservation |
| **Owner**      | the owner's passkey (secp256r1 / WebAuthn) | any payment; create, renew, revoke grants; admin of the account              | onchain: the account's `__check_auth` verifies the passkey over the exact auth payload                   |

Everything else (Stellar, Soroban, MCP, x402, OAuth) is plumbing in service of that distinction. The wallet balance
and the connection's allowance are always shown as two different numbers: a wallet can hold 500 USDC while ChatGPT may
spend 5.

## Three permissions, kept separate

1. **MCP/OAuth connection**: this client may talk to the wallet service as this owner, for this wallet. Gives zero
   spending authority by itself.
2. **Spending grant**: this connection's key may call USDC `transfer` from the account, cumulative total ≤ N, until T.
   Installed onchain by the owner's passkey. Revocable offchain (service stops signing) and onchain (rule removed).
3. **Owner approval**: the passkey authorizes one exact payment intent, or a change to grants.

A new chat, reconnect, token refresh or wallet top-up never creates a fresh allowance. The grant is a durable record
with a stable `grant_id`; the allowance belongs to it, not to the session.

## Scope freeze: the demo flow

1. Connect an MCP client; the OAuth consent page opens the wallet site. Owner signs in / creates a passkey wallet
   (WebAuthn registration → relayer deploys the smart account with the passkey as admin signer).
2. Consent screen: "Allow **ChatGPT** to spend up to **5 USDC** total from **Personal** until **tomorrow 12:00**.
   Larger payments need your passkey." Passkey signs the context-rule install. Connection becomes active.
3. Agent calls `wallet_overview`: balance 30 USDC (the video wallet is funded from the treasury; a judge's fresh testnet wallet gets 10 USDC), allowance 5.00 remaining, expiry, pending approvals.
4. Agent buys one x402 resource for 0.10 USDC (`paid_resource_fetch`). No owner prompt. Allowance 4.90.
5. Agent sends 2 USDC to saved contact Alice (`payment_prepare` → `payment_execute`). Allowance 2.90.
6. Agent requests 20 USDC "dinner" to Bob → `requires_approval` + approval URL.
7. Owner opens the link, sees recipient address + name, amount, requester, and approves with the passkey. Agent polls
   `payment_status` and gets a confirmed receipt. Allowance still 2.90 (owner lane does not consume the grant).
8. Agent repeats the exact same request (same idempotency key) → same receipt, no second payment. Agent requests 4 USDC
   → `requires_approval` because 4 > 2.90 remaining (not an onchain revert; the service routes it to the owner lane).
9. Owner revokes the connection on the site; the next delegated payment is refused, and the onchain rule is gone.

Unlocked extension (priority 5): "Send Carol 5 USDC" where Carol's classic `G…` account has no USDC trustline. The
wallet marks her **Trustline required**, generates an acceptance link, Carol signs the `trust` auth entry, and the
wallet executes one atomic invocation: USDC SAC `trust(carol)` + `transfer(owner, carol, 5)`.

## Actors

- **Owner**: human with a passkey on the wallet site.
- **Connection**: an MCP client authorized by the owner (ChatGPT dev mode, Claude, Goblin). Holds an OAuth token only.
- **Wallet service**: our Worker. Holds encrypted connection keys and the relayer key behind a narrow signer boundary.
  Builds intents, enforces grants, signs auth entries, submits transactions, reconciles receipts.
- **Relayer**: a funded classic `G…` account owned by the service. It is the transaction source and fee payer for
  every smart-account transaction. The owner never needs XLM.
- **Recipient**: a contact destination: `C…` smart account, `G…` classic account (USDC ready or trustline required),
  or `M…` muxed address.
- **Seller**: an x402 resource that accepts Stellar testnet USDC.

## Architecture

```
MCP host (ChatGPT / Claude / Goblin)
   │ OAuth 2.1 (PKCE, DCR)          ┌──────────────────────────────┐
   ▼                                │ Wallet site (Foldkit SPA)    │
Wallet Worker  /mcp  /api  /oauth   │ sign-in · passkey · consent  │
   │ Effect HTTP + MCP SDK          │ approvals · contacts · feed  │
   ├─ grants, intents, contacts, receipts (D1 + Durable Object for serialized reservations)
   ├─ signer boundary: relayer key, encrypted connection keys, WebAuthn assertion → auth entry
   ├─ x402 client (@x402/core + @x402/stellar), MCP x402 transport (@x402/mcp)
   ▼
Stellar testnet (Soroban RPC)
   ├─ OpenZeppelin smart account (passkey admin, Ed25519 connection signers, spending-limit policy)
   ├─ USDC Stellar Asset Contract (Circle testnet USDC, 7 decimals)
   └─ onboarding router: SAC trust + transfer in one invocation (Unlocked)
```

Deployed on Cloudflare via Alchemy (stages `local` and `testnet`), following the foundation the previous session
pinned: Effect 4.0.5, Foldkit 0.169.x, Alchemy 2.0.0-beta.83 exactly, TypeScript 7.0.2, Bun 1.4.2,
`@stellar/stellar-sdk` **16.4.1** (17.x breaks smart-account-kit and passkey-kit; verified 2026-10-25), soroban-sdk 29.0.1, stellar-cli 28.1.0. Exact Stellar library pins come from
`docs/research/`.

## MCP tool surface (small on purpose)

| Tool                      | Kind  | Semantics                                                                                                                                 |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet_overview`         | read  | balances, grant remaining/expiry, pending approvals, recent receipts                                                                      |
| `contacts_search`         | read  | name → contact with destinations, each with readiness: `usdc_ready`, `trustline_required`, `account_missing`, `unverified`, `paid_before` |
| `payment_prepare`         | write | resolve recipient + amount + asset → frozen `payment_intent` with a quote: lane (`autonomous`/`owner`), fee ceiling, expiry               |
| `payment_execute`         | write | execute an existing intent in the autonomous lane; refuses if the lane is `owner`, the grant is exhausted, expired or revoked             |
| `payment_approve_url`     | read  | approval link for an intent that needs the owner                                                                                          |
| `payment_status`          | read  | state machine + receipt once settled; never triggers a payment                                                                            |
| `paid_resource_fetch`     | write | GET a URL; on 402 build a Stellar payment within the grant (or return `requires_approval`), retry, return content + receipt               |
| `paid_mcp_call`           | write | same for a downstream MCP tool over the x402 MCP transport (stretch)                                                                      |
| `connection_grant_create` | write | returns an owner URL to create/renew a grant (never grants itself)                                                                        |
| `connection_grant_revoke` | write | disables the service grant immediately; schedules onchain rule removal                                                                    |

Rules: every write references a frozen intent; no tool accepts a raw transaction or an agent-supplied `approved: true`;
every tool call carries an idempotency key; results include `grant_remaining` so the host can show it.

## Data model

| Entity                | Key fields                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wallet`              | id, owner_id, contract_id (C…), passkey credential id + public key, network, created_at                                                                |
| `connection`          | id, owner_id, wallet_id, oauth client id + name, status (`active`/`revoked`), created_at                                                               |
| `spending_grant`      | id, connection_id, signer public key, encrypted private key ref, asset, total, spent, reserved, valid_until, onchain rule id, status                   |
| `contact`             | id, owner_id, display name, aliases, destinations[] {address, network, memo?, readiness, verified_at, last_paid_at}                                    |
| `payment_intent`      | id, idempotency_key, wallet_id, connection_id?, recipient destination, asset, amount (7-dp integer), fee ceiling, lane, status, expires_at, created_at |
| `payment_reservation` | intent_id, grant_id, amount, state (`held`/`consumed`/`released`)                                                                                      |
| `operation`           | intent_id, tx hash, submitted_at, ledger, status (`prepared`/`submitted`/`confirmed`/`failed`/`unknown`), raw result                                   |
| `receipt`             | operation_id, amount, fee, recipient, confirmed ledger/time, explorer URL, requester, lane                                                             |

Intent state machine: `prepared → (autonomous) reserved → submitted → confirmed | failed`; `prepared → (owner)
awaiting_approval → approved → submitted → confirmed | failed`; any state `→ expired` before submission. Exact retries
return the existing intent; a lost response never pays twice because the reservation and the submit intent live in one
Durable Object.

## Grant semantics

- Product meaning: **"N USDC total until T"**. Not per payment, not per day.
- Onchain: the connection signer's context rule is scoped to the USDC SAC `transfer` function with a spending-limit
  policy whose window is at least the grant lifetime, plus `valid_until = T`. Spike S1 confirms the exact policy
  shape; if the built-in policy is a rolling window, we size the window ≥ lifetime so nothing ages out before expiry.
- Offchain: the service reserves the amount on the intent before signing, so concurrent calls cannot double-spend the
  remaining allowance; the onchain policy remains the final authority.
- Owner-lane payments do not consume the grant. Top-ups do not change it. Renewal is a new owner approval.
- Two revocations, both visible: service grant disabled (instant) and onchain rule removed (one relayer transaction).

## Approval link semantics

- The URL identifies a pending intent. Opening or previewing it has no side effect.
- The page requires the owner to be signed in on that device and shows: recipient name **and** address, amount, asset,
  network, fee ceiling, which connection asked and why (free-text reason from the agent, marked as the agent's claim).
- The passkey assertion signs the smart account's authorization payload for exactly that invocation. The service cannot
  substitute a different recipient or amount after approval because the digest binds them.
- Expiry: intents awaiting approval expire (default 30 min). The agent learns the state only via `payment_status`.

## Contacts and recipient readiness

Readiness is computed from chain state at prepare time: `C…` → ready if the contract exists; `G…` → ready if the
account exists and has the USDC trustline; `G…` without trustline → `trustline_required` (acceptance flow); no account
→ `account_missing` (out of scope for the demo, show the state). Inbound payments never create trusted contacts; an
address change on an existing contact requires owner confirmation on the site.

## x402: the pocket model (decided 13:00 UTC)

Hosted facilitators reject smart-account payers today (policy events, fee caps), and Kristjan ruled out running our own
facilitator: a product that only works with its own facilitator is not a product. So the smart account never pays a
seller directly. Instead the connection key `K` plays two roles:

1. **Rule signer** on the smart account: a context rule scoped to USDC `transfer` with the spending-limit policy
   (N total until T). This is the budget, enforced onchain.
2. **Pocket**: `K` is also the key of its own classic `G…` account, created and reserve-funded by our relayer with a USDC
   trustline. It holds only what it has pulled.

An x402 purchase is two transactions: `K` pulls exactly the price from the smart account into its pocket under the
policy, then pays the seller from the pocket with the stock `@x402/stellar` client through a **third-party facilitator**
(x402.org or OpenZeppelin Channels; S2 measures both). Fees for the second step are sponsored by the facilitator. The
receipt carries both hashes. Payments to people go from the smart account directly under the same rule, one
transaction, so the policy counts both paths against the same N.

- The service does the whole negotiation: request → 402 → validate (network `stellar:testnet`, asset = USDC SAC, price ≤
  remaining, payTo, expiry) → pull → sign → retry → return content + receipt.
- Over-budget x402 purchases never reach the facilitator: the pull is refused onchain by the policy, or routed to the owner
  lane by the service before that.
- Revoke: remove the rule, sweep the pocket's leftover USDC back to the smart account, mark the connection revoked.
- Sellers for the demo: one HTTP resource we run (Hono middleware) that advertises a Stellar option; if time, one
  x402-paid MCP tool over `@x402/mcp`. We do not convert across chains.
- Dropped: our own facilitator, and a C-address payer scheme. If upstream fixes land (x402 PRs #3399, #3860), the smart
  account can pay directly and the pull step disappears; nothing else changes.

## Acceptance tests (the judges' checklist)

1. A 0.10 USDC x402 purchase settles and consumes the grant.
2. A payment above the remaining allowance is routed to the owner lane, never signed with the connection key.
3. A forced over-limit transfer signed with the connection key is **rejected onchain** (negative test for the policy).
4. A 20 USDC payment requires the passkey; the approval binds recipient and amount.
5. Repeating the same request does not pay twice.
6. Revoking the connection blocks the next delegated payment.
7. A receipt is returned only after confirmed settlement.
8. (Unlocked) A `G…` recipient without a USDC trustline receives USDC in one atomic trust + transfer invocation, after
   signing the acceptance.
9. The relayer paid every fee; the owner account holds no XLM.

## Non-goals for the hackathon

Circle Gateway (Stellar unsupported), MPP sessions, anchors/cash-out, swaps/DEX, confidential payments/ZK, Passkey Kit
(different account contracts), publishing to the ChatGPT store (OpenAI's policy prohibits executing crypto transfers;
we demo in a host we control and keep the server host-agnostic), mainnet.

## Tracks and framing

- **Stellar Composed** (primary): smart account + OpenZeppelin policies + relayed fees + MCP + x402 USDC payments.
  The track text literally suggests "agent wallets, OpenZeppelin spending policies, paid APIs over x402".
- **Stellar Unlocked** (supporting): CAP-73 SAC `trust` makes recipient onboarding part of the payment itself.
- Genesis path. Submit one project; mention both tracks in the answers.

Pitch: _Give your AI a spending budget you control. Pay people and services from one passkey wallet; larger payments
come back to you for approval._

Demo video (≤ 3 min, screen recording with voice): the nine steps above, then the trustline onboarding, then revoke.
Show the explorer for two transactions (a delegated one and the owner-approved one).

## Ideas backlog (post-hackathon, written down so we stop debating them)

- **Payment requests**: "send me 20 USDC" links/QR, including dinner splitting across contacts.
- **Task budgets**: a connection with 5 USDC allocates 1 USDC to one task; application-level, parent limit intact.
- **Agent-to-agent escrow**: reserve funds for another agent's work, release on approval (Sidequest / Trustless Work).
- **CCTP top-up**: "I have USDC on Base/Arc, move enough to my Stellar wallet" via CctpForwarder to the `C…` account.
- **Recovery signer**: a second passkey or guardian rule.
- **Merchant allowlists** and per-payment ceilings as extra policies.
- **MPP sessions** for many tiny calls to one service; **anchors** for cash-out; **privacy** when the verifier is ZK.

## Open decisions (owner's call)

1. ~~Name~~ decided: **Nod** (user-facing); `docs/PITCH.md` owns the words.
2. Demo host: Goblin (ours, OAuth client proven), Claude (custom connector), or ChatGPT developer mode. Recommendation
   pending research in `docs/research/hackathon-and-ecosystem.md`.
3. Foldkit for the wallet site, as the previous session planned, or the plainest thing that renders four pages.
4. Attempt CCTP top-up only if S1–S4 are green by 16:00 UTC.

## Decisions log

- 2026-10-25 12:30 UTC, from `docs/research/hackathon-and-ecosystem.md`: **demo host is Claude** (claude.ai custom
  connector or Claude Desktop; Claude Code as backup). It accepts a static client id, CIMD or DCR, renders MCP Apps, and
  has no money-transfer prohibition. **Goblin is the fallback we control.** ChatGPT appears only as a cameo, if at all:
  its policy prohibits "Execution of money transfers, crypto transfers, or investment trades".
- Same source: OAuth is `@cloudflare/workers-oauth-provider` 1.2.4, laid out like Stellar's Raven server. The
  per-connection grant lives in the OAuth grant props; the consent page is where the passkey signs the onchain rule.
- Same source: the CAP-73 feature is a **claim link**. The recipient signs the `trust` auth entry; the sender's transfer
  and an optional 0.5 XLM reserve top-up ride in the same router call. We never promise "pay any G address silently".
- A Genesis project may enter both tracks. Name Composed and Unlocked explicitly in the README and the answers.
- 2026-10-25 12:40 UTC, from `docs/research/x402-stellar.md`: **the demo seller runs our own facilitator.** Hosted
  facilitators (x402.org, OpenZeppelin Channels) reject OpenZeppelin smart accounts whose policy emits an event and cap
  fees below what a smart account costs, and the stock `@x402/stellar` client cannot sign as a C-address. We ship a
  small scheme class that signs with our account's auth payload, and an in-process facilitator with a 1M-stroop ceiling.
  Third-party sellers get a G-account fallback lane until the upstream fixes merge. Stellar's docs state "there is no
  policy layer for x402 on Stellar today": that gap is the product.
- 2026-10-25 13:00 UTC, Kristjan: **no facilitator of our own; the demo pays through a third-party facilitator.** This
  supersedes the 12:40 entry. Features that only work with our facilitator are dropped; the x402 section now describes
  the pocket model that hosted facilitators accept today.
- 2026-10-25 13:00 UTC, Kristjan via the pitch session: the product is presented as **Nod**; user-facing text follows the
  vocabulary in `docs/PITCH.md` (allowance, needs your nod, Nod pays the network fee). Enums and field names in tool JSON
  and `/api` stay unchanged. Session a3 owns pitch, landing copy, deck, README product sections and the video.
- 2026-10-25 13:05 UTC, Kristjan: demo amounts are **5 USDC allowance, 20 USDC dinner, 5 USDC to Carol**, same on testnet
  and mainnet. Outflow from the video wallet is 28 USDC (1 USDC pocket pull, 2 to Alice, 20 to Bob, 5 to Carol); the pocket's
  0.90 leftover is swept back on revoke. Mainnet funding: ~50 XLM and ~30 USDC, all to our own accounts.
