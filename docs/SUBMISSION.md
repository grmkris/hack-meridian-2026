# Submission: Nod

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

## Deck, demo video and words

The deck outline (one slide per rubric line), the demo video's voice-over lines and shot list, the promo film brief, the
landing page sections and the vocabulary live in [PITCH.md](PITCH.md). The product is presented as **Nod**. Fallbacks: if
the trustline beat is not green on the real service by 06:00 UTC, cut it and extend the revoke beat; if Claude's
connector flow fails on the day, record in Claude Code (proven in S4).

## Draft answers (adapt to the portal's questions)

- **Problem.** AI assistants can research, plan and shop, but when one has to pay, its owner either hands over
  everything (a card, a key) or makes the payment themselves. Stellar's docs say "there is no policy layer for x402 on
  Stellar today." People need an allowance they can see, a limit enforced where the money is, and one tap to approve
  the exceptions.
- **Solution.** Nod is a passkey-owned Stellar smart account that any MCP client (Claude first) spends from inside an
  allowance the owner sets: N USDC until T, separately for each AI app. Inside the allowance, paid APIs and payments to
  contacts go through on their own. Anything bigger comes back as a link the owner's passkey signs for that exact
  recipient and amount. Receipts come only after settlement, a repeated request pays once, and revoking works instantly
  in the service and on Stellar.
- **Stellar features used.** OpenZeppelin smart account with WebAuthn (secp256r1) and Ed25519 verifiers; a context rule
  scoped to the USDC Stellar Asset Contract with OpenZeppelin's spending-limit policy and an expiry, one per AI app;
  Soroban authorization entries signed by a per-app key and re-simulated in enforcing mode; fees paid by a relayer
  account so the owner never holds XLM; Circle USDC on the SAC; x402 paid through third-party facilitators (x402.org,
  OpenZeppelin Channels) from a small sponsored-reserve account the app key fills under the policy (the pocket model);
  the CAP-73 SAC `trust` function in a claim link, so the recipient signs once and the trustline and the transfer land
  in one invocation.
- **Tracks.** Composed: OpenZeppelin smart accounts and policies, passkeys, Circle USDC, x402 facilitators and MCP over
  OAuth, combined into something none of them does alone. Unlocked: trustline creation through the SAC makes recipient
  onboarding part of the payment.
- **Built during the event.** Everything in this repository: research with pinned versions, five spikes with testnet
  transaction hashes, the wallet service, the site, the demo seller. The commit history starts on 25 October. Prior
  work and own libraries: to be written (Kristjan).
- **How to test.** Filled in from `evidence/JUDGE-TEST-PATH.md` after the first testnet run: URL, connector URL, a
  passkey wallet auto-funded with 10 testnet USDC, the steps with expected results.
- **What is next.** A mainnet pilot with one AI app; a recovery passkey; task budgets inside an allowance; payment
  requests and bill splitting; agent-to-agent escrow. Upstream: once x402 facilitators accept smart-account payers
  (x402 PRs #3399, #3860), the pocket step disappears and nothing else changes.

## Judge test path

Live since 13:43 UTC: site https://hack-meridian-testnet.kristjan-grm11775.workers.dev, MCP connector
https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp. Steps for a judge: `evidence/JUDGE-TEST-PATH.md` (Claude
connector first). A fresh wallet is auto-funded with 10 testnet USDC. Reference run with explorer links:
`evidence/demo/2026-10-25T13-38-30-890Z/`.
