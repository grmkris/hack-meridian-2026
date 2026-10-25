# Submission: stellarmcpwallet

Deadline **2026-10-26 12:00 UTC** (12:00 Lisbon, 13:00 on the netcup box). Portal: https://app.hackmeridian.com (sign
in with the registered email). Path: **Genesis**. Tracks: **Stellar Composed** (primary) and **Stellar Unlocked**
(supporting); a Genesis project may enter both. Target submit time **11:00 UTC**, then re-check every link in a private
window. Source for rules and rubric: `docs/research/hackathon-and-ecosystem.md`.

## Fill in from the portal (Kristjan, 15 minutes, as early as possible)

| Field                              | Value                                |
| ---------------------------------- | ------------------------------------ |
| Demo video length limit            | UNVERIFIED (plan ≤ 3 min)            |
| Pitch deck format                  | UNVERIFIED (plan PDF, 8–10 slides)   |
| Submission questions (verbatim)    | UNVERIFIED                           |
| Team members and emails registered | UNVERIFIED                           |
| Track selection mechanics          | UNVERIFIED (both tracks are allowed) |

## Checklist

| #   | Item                                                                                                                         | Owner                        | When (UTC)                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------- |
| 0   | Portal fields above copied into this file                                                                                    | Kristjan                     | now                              |
| 1   | Public repo `grmkris/hack-meridian-2026` pushed; small commits keep landing on `main`                                        | foundation session, then all | today                            |
| 2   | README: problem, how it works, specs, architecture, testnet ids, explorer links, run, judge test, prior work, AI attribution | docs agent                   | 17:00–20:00 draft, 08:00 final   |
| 3   | Demo video: script below, screen recording with voice, upload                                                                | Kristjan + agent             | record by 07:00, upload by 09:30 |
| 4   | Pitch deck: one slide per rubric line (below), PDF                                                                           | docs agent                   | skeleton 18:00, final 09:00      |
| 5   | Submission answers drafted below, pasted into the form                                                                       | Kristjan                     | 10:00–10:30                      |
| 6   | Judge-testable deployment: URL, funded testnet path, a test connection the judge can use                                     | build                        | verified 09:00                   |
| 7   | Submit; re-check links privately                                                                                             | Kristjan                     | 11:00                            |

## Rubric to deck

Each criterion is scored 1–5. Genesis is judged on problem clarity, MVP quality, Stellar integration, continued
development potential.

| Slide | Criterion (weight)                 | Content                                                                                                                                            |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Title                              | **stellarmcpwallet.** Your agent can pay people and buy services. You decide how much it can spend.                                                |
| 2     | User Value & Problem (20%)         | Agents need to spend; owners need control. Today it is full keys or nothing. Stellar's docs: "there is no policy layer for x402 on Stellar today". |
| 3     | What we built                      | Two lanes: autonomous inside an onchain, expiring allowance; owner via passkey approval link. One wallet, any MCP client.                          |
| 4     | Track Alignment (20%)              | Composed: OpenZeppelin smart account + spending-limit policy + relayed fees + x402 + MCP. Unlocked: SAC `trust` claim link (CAP-73).               |
| 5     | Technical Execution (15%)          | Architecture; onchain enforcement with the rejection shown; frozen intents and idempotency; our facilitator and C-address scheme; testnet ids.     |
| 6     | Innovation (15%)                   | Per-connection onchain budget; approval bound by the auth digest; first-payment trustline in the same invocation; an x402 policy layer.            |
| 7     | Hackathon Progress (10%)           | Commit timeline: research → spikes with tx hashes → product. Nothing of this existed before the event; conventions came from our own repos.        |
| 8     | Market & Ecosystem Potential (10%) | Every MCP client is a customer surface; agent-to-agent escrow (Sidequest); CCTP inflow; task budgets; payment requests.                            |
| 9     | Product Design & UX (10%)          | Consent screen, approval page, activity feed. No seed phrase, no XLM, two numbers that never blur: balance and allowance.                          |
| 10    | Next and ask                       | Mainnet pilot with one MCP host; recovery signer; CCTP top-up; what we need from SDF/OpenZeppelin (facilitator fixes #3399, #3860).                |

## Demo video script (≤ 3 minutes)

Screen recording: Claude (custom connector) on the left, the wallet site on the right, stellar.expert testnet when a
transaction confirms. One voice, no music. Each beat shows the two numbers: wallet balance and remaining allowance.

| Time | On screen                                                                                                               | Voice                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Title card                                                                                                              | "Your agent can pay people and buy services. You decide how much it can spend. This is stellarmcpwallet, on Stellar."                   |
| 0:10 | Add the connector in Claude; consent page opens; passkey prompt; "ChatGPT/Claude may spend up to 5 USDC until tomorrow" | "I connect Claude. My passkey creates the wallet and signs one rule onchain: this connection may spend five USDC, until tomorrow."      |
| 0:35 | `wallet_overview` result: 50 USDC balance, 5.00 allowance                                                               | "Two numbers. The wallet holds fifty. The agent may spend five."                                                                        |
| 0:45 | "Buy the market brief" → `paid_resource_fetch` → content + receipt; allowance 4.90                                      | "It buys a paid API result over x402. No prompt. The receipt shows the settlement, and the allowance drops."                            |
| 1:05 | "Send Alice 2 USDC" → prepare, execute, receipt; allowance 2.90; explorer tab                                           | "It pays a saved contact. Signed by the connection key, fees paid by our relayer, enforced by the policy on chain."                     |
| 1:25 | "Pay Bob 100 USDC for dinner" → `requires_approval` + link; approval page; passkey; receipt                             | "A hundred is above its budget. The agent gets a link. I open it, see Bob's address and the exact amount, and approve with my passkey." |
| 1:55 | Same request again → same receipt. "Send 4 USDC" → `requires_approval`                                                  | "Ask twice, pay once. Four is more than what is left, so it comes back to me."                                                          |
| 2:10 | "Send Carol 10 USDC" → Trustline required → claim link → Carol signs → one transaction                                  | "Carol has never held USDC. She signs once, and the trustline and the payment land in the same transaction."                            |
| 2:35 | Revoke on the site → next delegated payment refused; rule gone on chain                                                 | "Revoke, and the connection is done, off chain and on."                                                                                 |
| 2:50 | End card: repo, tracks                                                                                                  | "stellarmcpwallet. Stellar Composed and Unlocked."                                                                                      |

Fallbacks: if the Unlocked beat did not pass S3 with a transaction hash, cut it and extend the revoke beat. If Claude's
connector flow is not working on the day, record in Goblin.

## Draft answers (adapt to the portal's questions)

- **Problem.** AI agents that act for people need to pay for things. Giving an agent a private key gives it everything;
  giving it nothing makes it useless. Owners need budgets they can see, limits enforced where the money is, and a way to
  approve the exceptions in one tap.
- **Solution.** A passkey-owned Stellar smart account that MCP connections spend from inside an owner-set, expiring
  onchain allowance. Small payments and paid API calls go through alone. Larger ones return an approval link the passkey
  signs for the exact recipient, asset and amount. Receipts come only after confirmed settlement; repeated requests do
  not pay twice; revocation works offchain and onchain.
- **Stellar features used.** OpenZeppelin smart account with Ed25519 and WebAuthn (secp256r1) verifiers and the
  spending-limit policy; Soroban authorization entries signed by a per-connection key; relayed fees from a sponsor
  account; Circle USDC on the Stellar Asset Contract; x402 Stellar scheme with our own facilitator; CAP-73 SAC `trust`
  for first-payment onboarding in one invocation.
- **Tracks.** Composed: it combines OpenZeppelin policies, smart accounts, x402 and MCP, with CCTP as the inflow path.
  Unlocked: SAC trustline creation makes recipient onboarding part of the payment.
- **Built during the event.** Everything: research with pinned versions, five spikes with testnet transaction hashes,
  the wallet service, the site, the demo seller and facilitator. Conventions and tooling came from our own earlier
  repos; no wallet code existed before 25 October.
- **How to test.** URL, a test connection, a funded testnet wallet, and the exact nine steps, filled in after the build.
- **What is next.** A mainnet pilot with one host; a recovery signer; CCTP top-up; task budgets and payment requests;
  agent-to-agent escrow with Sidequest.

## Judge test path

To be filled after the build: deployed URL, how to connect the MCP server, a test owner or a pre-made connection, the
nine steps with expected results, explorer links for the delegated and the owner-approved transactions, and the
contract ids.
