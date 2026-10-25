# Spikes: prove the risky parts before building the product

Status: draft v0, 2026-10-25 11:45 UTC. Deadline Mon 26 Oct 12:00 UTC. See `docs/SPEC.md` for the product and
`docs/research/*.md` for pinned versions, URLs and live-endpoint probes.

## Why spikes, and the clock

About 24 hours remain. Five things could change the architecture, and none has been executed end to end on this stack:

1. The authority model: a passkey-admin OpenZeppelin smart account with a budgeted, expiring Ed25519 connection signer.
2. x402 on Stellar: a real facilitator, a seller we run, auth-entry signing, the MCP transport.
3. CAP-73 recipient onboarding: SAC `trust` + `transfer` in one invocation with two authorizers.
4. A remote MCP server with OAuth that Goblin and Claude can actually connect to, running on workerd with
   `@stellar/stellar-sdk`.
5. The foundation itself: Foldkit + Effect Worker + Alchemy stages, as the previous session planned but never scaffolded.

Plan:

| UTC         | What                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| 11:30–12:15 | this document, research pins land, owner decides host/name                                  |
| 12:15–16:00 | S0–S4 in parallel (Opus agents), each time-boxed; S5 starts when S1 and S2 report           |
| 16:00–17:00 | step back: read `docs/spikes/*.md`, lock the architecture, write the build plan             |
| 17:00–04:00 | build the product in parallel streams (contracts+signer, Worker+intents, site, seller, e2e) |
| 04:00–08:00 | end-to-end rehearsal of the nine demo steps on testnet; fix; screenshots                    |
| 08:00–11:00 | demo video, pitch deck, README, submission answers                                          |
| 11:00–11:45 | submit; buffer                                                                              |

## Rules for every spike agent

- **Testnet only.** Friendbot for XLM. Never touch mainnet. Never commit a secret: keys go in `spikes/<id>/.env` (gitignored) and
  are printed to the results doc only as public keys / contract ids.
- **Own paths only**: code in `spikes/<id>/`, results in `docs/spikes/<id>.md`. Do not edit `apps/`, `contracts/`, `package.json`
  or another spike's files. Commit only your own paths **with a pathspec on the commit too**: `git add <paths> && git commit -m "…" -- <paths>`. A plain `git commit` commits whatever other sessions have staged in the shared index (this happened once today). On `index.lock` wait and retry. Work on `main`.
- **Rust builds share a target dir**: `export CARGO_TARGET_DIR=/srv/cache/hm26-target/<id>` (the home volume is 90% full).
  Run builds and test suites through `heavy` (exit 75 = busy, retry). Never pipe `heavy`.
- **Pins**: use the versions in `docs/research/*.md`. If a pin is wrong, say so in the results and pick the version that works.
  Note from the foundation session: its generated Soroban bindings (`packages/counter-client`) pin `@stellar/stellar-sdk`
  **16.4.1** because stellar-cli 28.1 generates for 16; the Kit or x402 packages may want 17.x. Spikes use their own
  `spikes/<id>/package.json` (not a workspace member) and report which SDK version worked, so the build picks one.
- **Proven already**: stellar-cli 28.1.0 + soroban-sdk 29.0.1 build, deploy and invoke on protocol-29 testnet (counter
  contract `CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2`). Do not re-prove the toolchain.
- **Time box is real.** When it runs out, write the results doc with what passed, what failed, and the best next step.
  A partial result with evidence beats a late success.
- **Evidence or it did not happen**: every onchain claim has a transaction hash and a `stellar.expert` testnet link; every
  HTTP claim has the request and the response status; negative tests (expected rejections) are recorded as carefully as
  positive ones.
- **Results doc format** (`docs/spikes/<id>.md`): Question · Setup (versions, accounts, contract ids, exact commands) ·
  What happened (step by step with evidence) · Result (PASS / FAIL / PARTIAL per claim) · Recommendation for the build ·
  Reusable code (paths, what each exports) · Open risks.
- Reply to the orchestrator with ≤ 25 lines: verdict per claim and the one thing the build must know.

## S0 · Foundation — DONE by the concurrent foundation session (pushed 12:50 UTC)

Public repo: https://github.com/grmkris/hack-meridian-2026. Commits `2b791bc` (contract), `33a975b` (foundation files,
mislabelled as docs), `a48a457` (Alchemy stack + gates), `3994286` (scripts), `f9dd922` (agents/skills/MCP), `fe390ef`
(README/LICENSE/CI).

Layout the build goes on top of:

- `apps/web`: Foldkit SPA in `src/main.ts`; Worker in `src/worker.ts` + `src/server/{app,settings,counter}.ts`;
  `alchemy.run.ts` with stages `local` and `testnet`, local state only, dev port 18960, `assets.runWorkerFirst ['/api/*']`
  (add `/mcp` and `/.well-known/*` there when the MCP server lands).
- `packages/api`: the Effect HttpApi contract. `packages/counter-client`: generated bindings on `@stellar/stellar-sdk`
  16.4.1, compiled to `dist`.
- `contracts/counter`: soroban-sdk 29.0.1, deployed `CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2`.
- `scripts/{stage,smoke,shots,typecheck,contract}.ts`. `.mcp.json`: stellar-raven, cloudflare, rat-stack, mysi,
  foldkit-devtools. 28 vendored skills incl. `stellar-{smart-contracts,dapp,assets,data,standards,agentic-payments}`.

Verified green: `heavy bun run check` (oxfmt, repoagents, type-aware oxlint + Foldkit plugin, effect-tsrs over 5 projects,
15 vitest, clippy, 4 cargo tests, vite build); `bun run dev` on :18960; `smoke:local` 5/5; phone + desktop shots.
`/api/counter` reads the testnet contract from inside workerd with stellar-sdk 16.4.1 and no polyfill.

Not done by design: no testnet Worker deploy yet (`bun run deploy:testnet` is ready and reads the token from
`secrets.env`); no `/mcp`, D1, Durable Object or `packages/protocol`. Each is a build-phase addition.

Gotchas for build agents: workerd in alchemy beta.83 accepts compatibility dates ≤ 2026-10-09; `nodejs_compat` is the
default, do not list it; `spikes/` is excluded from lint and fmt but `docs/` is not; CI runs `bun run check` on every push
to `main`, so docs must stay oxfmt-clean; `AGENTS.md` carries the pathspec commit rule.

## S1 · Smart account authority model — 4 h (highest risk)

**Verified 2026-10-25 (docs/research/smart-accounts.md)**: no Rust needed. The OpenZeppelin account WASM, Ed25519 and WebAuthn verifiers and the spending-limit policy are deployed on testnet; one wallet = one `deploy` of the WASM. `smart-account-kit` 0.8.0 signs only the v0.7.x digest and has no headless Ed25519 signing, so the spike hand-signs auth entries with `authorizeEntry` (recipe in §c). Pin `@stellar/stellar-sdk` 16.4.1. The limit is a rolling window: size `period_ledgers` ≥ the rule lifetime; `valid_until` is a ledger number. Fee sponsoring = our G account as source, with a second (enforce) simulation after signing.

**Question**: can one OpenZeppelin smart account on testnet have (a) a passkey-style secp256r1 admin signer and (b) an
Ed25519 "connection" signer limited to USDC `transfer` ≤ N total until T, with over-limit and post-revoke transfers
rejected onchain and fees paid by a separate relayer account?

Claims to prove, in order (stop at the time box, report what is done):

1. Deploy the smart account on testnet from TypeScript using Smart Account Kit (`smart-account-kit` 0.8.0 on npm; verify in
   `docs/research/smart-accounts.md`), with an Ed25519 admin first (fastest path). Record the contract id and the
   stellar-accounts contract version actually deployed.
2. Fund the account with testnet USDC (Circle testnet USDC SAC; faucet or SAC `transfer` from a classic account per the
   research doc). Fallback: deploy a test asset SAC and say so.
3. Add a context rule for a fresh Ed25519 **connection** key: scope = USDC SAC `transfer` from the account; spending-limit
   policy with limit 5 USDC (50_000_000 stroops) over a window ≥ 24 h; `valid_until` = now + 2 h. Transaction source and fee
   payer = a different funded classic account (the relayer); the smart account authorizes through its auth entry.
4. Delegated transfer of 2 USDC → PASS onchain. Delegated transfer of 4 USDC (would exceed 5 cumulative) → REJECTED
   onchain (capture the error). Remove or expire the rule → next delegated transfer REJECTED.
5. Admin signer transfers 20 USDC → PASS and does not touch the connection's policy state.
6. Replace or add the admin with a **secp256r1/WebAuthn** signer. Use a software P-256 key that produces WebAuthn-shaped
   payloads (authenticatorData + clientDataJSON with the challenge = the auth payload digest), exactly as a browser
   passkey would; prove an admin transfer verifies onchain. Real-browser WebAuthn is for the build, not this spike.
7. Export a small TS module `spikes/s1/src/signer.ts`: `authorizeWithEd25519(entry, keypair)`,
   `authorizeWithWebAuthn(entry, assertion)`, `buildTransfer(account, to, amount)`, `submitViaRelayer(tx)`, plus the
   simulate → authorize → re-simulate → submit sequence that worked.

Record precisely: the digest format the deployed account expects (v0.7.3 vs v0.8.0), the policy's exact semantics (does it
count SAC `transfer` by the account; rolling window or fixed; what happens at the boundary), gas/fee numbers, and
whether Smart Account Kit or raw stellar-cli + stellar-sdk was faster. Fallback if the Kit blocks: deploy the
OpenZeppelin contracts with stellar-cli and drive them from stellar-sdk directly.

## S2 · x402 on Stellar, end to end — 3 h

**Question**: can we pay a Stellar x402 seller on testnet through a live facilitator from our own code, and does the MCP
transport work?

Claims:

1. Run a minimal seller (`@x402/hono` or the middleware the research doc names) on Bun on this box, priced 0.10 USDC on
   `stellar:testnet`, pointing at the facilitator the research doc verified as live. Record its 402 body.
2. Pay it with `@x402/stellar` from a **classic** Ed25519 account holding testnet USDC. Settlement tx hash + the
   `payment-response` header. Pay again with the same payment identifier (if supported) → no second settlement.
3. Negative: a price above our configured cap is refused by our client before any signature.
4. MCP transport (`@x402/mcp` 2.28.0): wrap one tool of a tiny MCP server behind x402; pay it from a client. Record the
   `_meta["x402/payment"]` and `_meta["x402/payment-response"]` payloads.
5. If S1 has published its account id and signer module by hour 2: pay the seller with the **smart account** as payer,
   signing the auth entry with the connection key. Otherwise document exactly which signer interface the Stellar scheme
   calls, so S5 can plug the smart account in.

Deliverables: `spikes/s2/seller`, `spikes/s2/client`, `spikes/s2/mcp-seller`, and the results doc with the exact
facilitator URL, its `supported` response, and uptime observations. Also reuse notes from Froggy's
`~/code/ethglobal-online-2026/packages/payments` (chain-agnostic challenge/requirement/receipt handling).

## S3 · CAP-73 recipient onboarding in one invocation — 2.5 h

**Question**: can a tiny router contract call USDC SAC `trust(recipient)` and then `transfer(sender, recipient, amount)`
in one transaction, where the recipient (a classic `G…` account with no USDC trustline) authorizes only the trustline and
the sender authorizes only the transfer?

Claims:

1. Create recipient `G…` via friendbot with no trustline; confirm USDC `balance` reads as no-trustline.
2. Build `spikes/s3/contracts/onboard` (soroban-sdk 29.0.1): `pay_and_trust(sender, recipient, token, amount)` that calls
   `token.trust(recipient)` then `token.transfer(sender, recipient, amount)`. Deploy to testnet.
3. Invoke with two auth entries (recipient signs `trust`, sender signs `transfer`); the relayer pays fees. PASS: recipient
   now has the trustline and the balance. Record the reserve requirement observed (did the recipient need +0.5 XLM?).
4. Negative: without the recipient's signature the invocation fails (capture the auth error).
5. Note whether `trust` is reachable from the SDK's `Contract`/`stellar contract invoke` for the SAC, and how a wallet like
   Freighter would sign the recipient's auth entry (the acceptance-link flow in the product).

Fallback if `trust` is not exposed as expected: document the exact error and whether a classic `ChangeTrust` from the
recipient plus a separate transfer is the only path.

## S4 · Remote MCP server with OAuth that real hosts connect to — 3 h

**Question**: which OAuth implementation gets Goblin and Claude connected to our Worker-hosted MCP server fastest, and
does the approval-link round trip work in those hosts?

Claims:

1. Pick in ≤ 20 minutes between `@cloudflare/workers-oauth-provider` 1.2.4 (KV-backed, DCR + PKCE built in) and porting
   Sidequest's OAuth (`~/code/agent-jobs/apps/api/src/oauth.ts`, `oauth-setup.ts`, `mcp.ts`, ~1,400 lines, Effect, its own
   storage). Record the reason.
2. Deploy a stub MCP server (`@modelcontextprotocol/sdk` 1.32.2, stateless Streamable HTTP) with OAuth metadata, DCR,
   PKCE, a minimal consent page, and two tools: `wallet_overview` (fixture) and `payment_prepare` that returns
   `requires_approval` with an `approval_url`. Deploy to a `workers.dev` URL (Alchemy `testnet` stage or `wrangler`).
3. Connect from **Goblin** (dev deployment; its client does discovery + DCR + PKCE) and call both tools. Screenshot.
4. Connect from **Claude** (claude.ai custom connector or Claude Code `claude mcp add --transport http`) and call both
   tools. Note whether DCR was required and whether URL-mode elicitation is available.
5. ChatGPT developer mode if an account with it is available; otherwise record the requirement list from the research doc.
6. Prove `@stellar/stellar-sdk` 16.4.1 runs (not 17.x: the smart-account kits require ^16.3) in the deployed Worker: build and sign a dummy transaction in a `/api/probe`
   route. Record any `node:` polyfill or `nodejs_compat` flag needed.

Deliverables: `spikes/s4/` deployable stub, the results doc with per-host screenshots and the exact OAuth flags each host
needed. This spike decides the demo host.

## S5 · Integration: x402 purchase from the smart account under the grant — 2 h (after S1 + S2)

Pay S2's seller with S1's account, signing with the connection key under the spending-limit rule; then exhaust the limit
and show the facilitator-side or onchain rejection. This is acceptance tests 1–3 in miniature and tells us whether the
facilitator can settle a contract-account payer. If it cannot, the fallback is the owner lane for x402 or our own
submission path (the service submits the transfer and then presents the receipt to the seller only if the seller
supports a verify-by-tx-hash mode; S2 should have noted whether that exists).

## S6 · CCTP top-up (stretch, only if S1–S4 are green by 16:00 UTC) — 3 h

Arc testnet → Stellar testnet USDC into the `C…` account through `CctpForwarder` (`mintRecipient` and
`destinationCaller` = forwarder; recipient in hook data; our relayer completes `mint_and_forward`). Six-decimal CCTP
amounts vs seven-decimal Stellar USDC must be converted explicitly. Not scheduled unless the core is green.

## What "step back" looks like at 16:00 UTC

Read the five results docs and answer, in `docs/BUILD-PLAN.md`:

1. Which account kit and contract version; the digest format; the policy shape and its exact limit semantics.
2. Which facilitator and seller; whether the contract-account payer settles; how the receipt is obtained.
3. Whether the Unlocked onboarding flow is in the demo (it must have passed S3 with a tx hash) or in the backlog.
4. Which host the video uses; which OAuth implementation; what the consent page must show.
5. The build streams, each with an owner agent, its paths, its acceptance test numbers from `docs/SPEC.md`, and the
   integration order. Then build.

## Submission work is 5–6 hours, not 3 h 45 (update 12:30 UTC)

From `docs/research/hackathon-and-ecosystem.md` §(a): README with specs and testnet ids (60–90 min), demo video
(90–120 min), deck (60–90 min), answers (30 min), judge-testable deployment check (30 min), submit and re-check (20 min).
Changes to the plan:

- **Kristjan, now (15 min):** sign in to app.hackmeridian.com, open the submission form, and paste the exact questions,
  the video length limit and the deck format into `docs/SUBMISSION.md`. Every "UNVERIFIED" in the checklist depends on it.
- The README product sections, the deck skeleton and the video script are written **during the build**, from 17:00 UTC,
  by a dedicated docs agent working from `docs/SPEC.md` and the spike results. Video recording starts by 07:00 UTC.
- Judging weighs "Hackathon Progress" (10%) on commit history during the event, so small commits keep landing on `main`
  and the public repo is pushed today.
