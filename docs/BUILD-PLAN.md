# Build plan: stellarmcpwallet

Status: architecture locked 2026-10-25 12:10 UTC after spikes S1–S4 passed (S5 integration running). Deadline Mon 26 Oct
12:00 UTC. Product: `docs/SPEC.md`. Evidence: `docs/spikes/s1.md`, `s2.md`, `s3.md`, `s4.md`. Every number and id below
comes from those docs.

## Decisions (from the spikes)

| Area                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account             | OpenZeppelin smart account, deployed per wallet from WASM `1b5f4534…`; rule 0 = owner passkey `External(WEBAUTHN_VERIFIER, pubkey)`; no Smart Account Kit at runtime; raw `@stellar/stellar-sdk` **16.4.1** everywhere.                                                                                                                                                                                                                                                                                                                                          |
| Grant               | one grant = one context rule `CallContract(USDC_SAC)` with signer `External(ED25519_VERIFIER, K)` and policy `SPENDING_LIMIT {period_ledgers: L + 720, spending_limit: N}`, `valid_until = latest + L`, `L = ceil(lifetime_s / 5)`. Persist the returned rule id. Renewal = new rule, then remove the old one.                                                                                                                                                                                                                                                   |
| Signing             | `spikes/s1/src/signer.ts` moves into the chain package: simulate → `authorizeEntry` → **enforce simulation** → assemble → relayer signs → send → poll. Over-limit fails at the enforce simulation (`#3221`), never onchain. Error map: `#3221` exhausted → owner lane; `#3002` expired; `#3000` removed; `#3223` not a transfer; SAC `#10` insufficient balance.                                                                                                                                                                                                 |
| Fees                | relayer `G` is source and payer. Testnet today: grant install 3–14 XLM, first payment under a rule 11–17 XLM, further delegated payments ~1.5 XLM, owner payment ~0.002 XLM. S1 verified this is **real storage rent at ~47× normal** (testnet state is over its 4 GB target); at normal rent a delegated payment is ~333k stroops. Size fee ceilings from the **enforce** simulation only: ≥ 25 XLM for a grant's first payment, ≥ 2 XLM after. Keep 2–3 funded relayers (≥ 500 XLM each) and read the rent factor before recording.                            |
| People payments     | direct from the smart account under the rule (one tx). Recipient readiness from chain state; `G…` without trustline → claim link (S3 router `CCLFB4I4…`, first simulation `authMode: 'record_allow_nonroot'`, recipient needs 1.5 XLM).                                                                                                                                                                                                                                                                                                                          |
| x402                | pocket model: `G(K)` created with **sponsored reserves** on grant install; `paid_resource_fetch` pulls the **shortfall** from the smart account under the rule, then pays as a plain G account through **x402.org** (fallback OpenZeppelin Channels, key in a secret); `paid_mcp_call` same via `@x402/mcp`. Idempotency lives in our intent store **before the pull**. Revoke sweeps `G(K)` back. S5 decides the chunk size.                                                                                                                                    |
| OAuth / MCP         | `@cloudflare/workers-oauth-provider` 1.2.4 with the Durable Object KV shim from S4 (`spikes/s4/src/kv-shim.ts`); DCR **and** CIMD; `apiRoute '/mcp'`; stateless Streamable HTTP, JSON responses, POST only; `@modelcontextprotocol/sdk` 1.32.2. One consent = one OAuth grant = one connection = one spending grant; `props` carry owner, wallet, connection, grant snapshot; mutable state in D1/DO; never key on `client_id`; revoke = `revokeGrant` + service flag + `remove_context_rule`; approval link in the tool result text and in `structuredContent`. |
| Consent page        | server-rendered by the Worker at `/authorize`: client name ("Published by <domain>" for CIMD), redirect host, wallet, allowance + expiry (editable), "Larger payments need your passkey", passkey sign-in; the passkey assertion that installs the rule happens on this page's POST before `completeAuthorization`.                                                                                                                                                                                                                                              |
| Approval page       | server-rendered at `/approve/<intent>`: recipient name and address, amount, asset, network, fee ceiling, requester; `navigator.credentials.get` with challenge = `webAuthnChallenge(entry, [0], validUntilLedger)`; POST assertion → `authorizeWithWebAuthn` → `finalizeInvocation` (re-reads relayer sequence). Intents awaiting approval expire after 30 min (≈ 400 ledgers).                                                                                                                                                                                  |
| Storage             | D1 for the eight entities in `docs/SPEC.md`; one Durable Object per wallet serializes reservations, intents and the submit claim; OAuth storage in the shim DO. No KV (token lacks the permission).                                                                                                                                                                                                                                                                                                                                                              |
| Pocket policy & TTL | pull `min(remaining, max(shortfall, 1.00 USDC))`; show remaining = policy remaining + pocket balance; idempotency checked before the 402; fee ceilings ≤ 3 XLM per pull (≤ 20 XLM for a grant's first), configurable; relayer funding ~50 XLM per connection per day + 1.5 XLM per open pocket. **The shared policy contract `CABXBYJN…` expires ≈ 27 Oct 02:30 UTC**: stream C extends all shared contracts by ≥ 14 days now; `/api/health` and the probe show TTLs; extend again before judging.                                                               |
| Hosting             | one Worker, Alchemy stages `local` and `testnet` (beta.83, local state), `runWorkerFirst ['/api/*', '/mcp', '/.well-known/*', '/authorize', '/oauth/*', '/approve/*', '/claim/*']`. Demo seller is a second small Worker.                                                                                                                                                                                                                                                                                                                                        |
| Demo host           | Claude (Claude Code proven live; claude.ai connector to be clicked by Kristjan). Goblin fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Judge test path     | a judge connects their Claude to our `/mcp`, creates a passkey wallet, and the service **auto-funds it with 10 testnet USDC** from a treasury account, then runs the nine steps. No shared credentials.                                                                                                                                                                                                                                                                                                                                                          |

## Streams and ownership

Four agents build in parallel on `main`, disjoint paths, pathspec commits, `heavy bun run check` before each commit.

| Stream | Owner                                                       | Paths                                                                                                                          | Delivers                                                                                                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1     | agent "service"                                             | `apps/web/src/server/**`, `apps/web/src/worker.ts`, `apps/web/alchemy.run.ts`, `packages/api/**`, `packages/protocol/**` (new) | OAuth provider + consent/approval/claim pages, `/mcp` with the ten tools, D1 schema + migrations, wallet Durable Object (intents, reservations, submit claim), grant lifecycle, contacts + readiness, receipts, `/api/*` for the SPA. Codes against the `Chain` interface below with a fixture implementation first.          |
| A2     | agent "chain"                                               | `packages/stellar/**` (new)                                                                                                    | the `Chain` interface implementation on stellar-sdk 16.4.1: account deploy, rule install/remove, direct payment, WebAuthn finalize, pocket create/pull/sweep, x402 fetch + MCP call, CAP-73 claim, treasury auto-fund, receipts. Unit tests on fixtures; one live testnet test per method behind an env flag.                 |
| B      | foundation session (confirmed 12:35 UTC, Kristjan approved) | `apps/web/src/**` except `server/` and `worker.ts`, `apps/web/index.html`, `apps/web/src/styles.css`, `scripts/**`             | Foldkit SPA: Home (balances, allowance, pending approvals, activity), Connections (remaining, expiry, revoke), Contacts (readiness badges), Receipts; passkey create during onboarding; phone + desktop shots; `smoke:testnet` extended to `/mcp` tools/list and `/.well-known`.                                              |
| C      | agent "demo"                                                | `apps/seller/**` (new), `scripts/demo/**` (new), `evidence/**`                                                                 | x402 seller Worker (Hono, `stellar:testnet`, $0.10, payment-id cache) + x402-paid MCP tool, deployed to workers.dev; seed contacts Alice (`C…`), Bob (`G…` ready), Carol (`G…` no trustline); `scripts/demo/rehearse.ts` that runs the nine steps against a stage through the MCP client and writes evidence; explorer links. |
| D      | agent "docs" (from 17:00)                                   | `docs/**`, README product sections (coordinate with B), `deck/**`                                                              | README per `docs/SUBMISSION.md`, deck PDF, video script timing, answers. Reads `evidence/**`.                                                                                                                                                                                                                                 |

## The `Chain` interface (A1 and A2 code against this from minute one)

```ts
interface Chain {
  deployAccount(ownerPasskey: { pubkey: Uint8Array }): Promise<{ contractId: string; tx: string }>
  fundNewWallet(contractId: string, usdc: bigint): Promise<{ tx: string }> // treasury → wallet, testnet only
  installGrant(
    contractId,
    signerPub: Uint8Array,
    limitStroops: bigint,
    lifetimeSeconds: number,
    ownerAssertion,
  ): Promise<{ ruleId: number; validUntilLedger: number; tx: string }>
  removeGrant(contractId, ruleId, ownerAssertion): Promise<{ tx: string }>
  readGrant(contractId, ruleId): Promise<{ spent: bigint; limit: bigint; validUntilLedger: number; live: boolean }>
  prepareOwnerTransfer(
    contractId,
    to,
    amountStroops,
    validForLedgers,
  ): Promise<{ entryXdr: string; challenge: Uint8Array; validUntilLedger: number }>
  finalizeOwnerTransfer(prepared, assertion): Promise<Receipt>
  delegatedTransfer(contractId, ruleId, signerKeyRef, to, amountStroops): Promise<Receipt> // people payments and pocket pulls
  createPocket(signerKeyRef): Promise<{ address: string; tx: string }> // sponsored reserves + USDC trustline
  sweepPocket(signerKeyRef, toContractId): Promise<Receipt>
  payX402(
    signerKeyRef,
    url: string,
    maxAmountStroops: bigint,
    paymentId: string,
  ): Promise<{ body: Response; settlement: Receipt }>
  payX402Mcp(
    signerKeyRef,
    mcpUrl: string,
    tool: string,
    args: unknown,
    maxAmountStroops: bigint,
    paymentId: string,
  ): Promise<{ result: unknown; settlement: Receipt }>
  readiness(address: string): Promise<'usdc_ready' | 'trustline_required' | 'account_missing' | 'contract'>
  prepareClaim(
    sender,
    recipient,
    amountStroops,
    validForLedgers,
  ): Promise<{ recipientEntryXdr: string; senderEntryXdr: string }>
  finalizeClaim(prepared, recipientSignedEntryXdr, senderSignedEntryXdr): Promise<Receipt>
  balances(address: string): Promise<{ usdc: bigint; xlm: bigint }>
}
type Receipt = { tx: string; ledger: number; feeStroops: bigint; feePayer: string; explorer: string }
```

Signer key refs resolve inside `packages/stellar` to encrypted Ed25519 secrets (vault key from a Worker secret);
the relayer and treasury secrets are Worker secrets. No secret leaves the chain package.

## Integration order

| UTC         | Milestone                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12:15–15:30 | A1: provider + `/mcp` + D1 + DO with fixture chain; A2: `Chain` on testnet with live tests; B: pages on fixtures; C: seller deployed, seeds funded. |
| 15:30–18:00 | A1 ↔ A2 wired on the `local` stage; consent installs a real rule; `wallet_overview` reads chain; tools 1–6 live. S5's chunk policy applied.         |
| 18:00–21:00 | `deploy:testnet`; Claude Code connects to the testnet URL; steps 1–9 pass once by hand; D starts README and deck from evidence.                     |
| 21:00–00:00 | claim link (step 10), revoke sweep, receipts UI, error states, phone layout; `scripts/demo/rehearse.ts` green against testnet.                      |
| 00:00–02:00 | freeze features; rehearse the recording twice; screenshots into `evidence/`.                                                                        |
| 02:00–08:00 | buffer and sleep. S6 (CCTP) only if everything above is green by 00:00.                                                                             |
| 08:00–11:00 | video, deck, README final, answers; judge test path verified in a private window.                                                                   |
| 11:00       | submit.                                                                                                                                             |

## Rules for build agents

- Read `docs/SPEC.md`, this file, your spike docs, and `AGENTS.md` before writing. Follow `~/CLAUDE.md` (heavy, no stash/reset).
- Own paths only. Need a change outside them (a binding, a route prefix, a shared type)? Message the owner, do not edit.
- Commit with a pathspec: `git add <paths> && git commit -m "<stream>: <what>" -- <paths>`. Small commits. Push is coordinated
  by the orchestrator; never force-push.
- Lockfile: CI installs with `--frozen-lockfile`. A commit that changes any `package.json` includes the regenerated root `bun.lock` in the same pathspec commit (`heavy bun install` first). Main went red once on 2026-10-25 for lack of this.
- Gate before each commit: `bunx oxfmt --check` at the root, and `heavy bun run check` at least every hour and before saying done.
- Testnet only. Secrets in `.env`/`.dev.vars` (gitignored) and Alchemy secrets; never in code, logs or docs.
- Acceptance tests in `docs/SPEC.md` are the definition of done; each stream names which numbers it covers.
- When blocked for more than 20 minutes, write the blocker in your reply and move to the next item.

## Mainnet (from `docs/research/mainnet.md`, 13:20 UTC)

Pubnet preset: RPC `https://mainnet.sorobanrpc.com` (60 req / 10 s), fallback `https://soroban-rpc.mainnet.stellar.gateway.fm`,
Horizon `https://horizon.stellar.org`; account WASM hash `1b5f4534…` (same as testnet); WebAuthn verifier
`CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR`; Ed25519 verifier `CBOOZV2BK5OETGL4Q4KGEBESPRLJFN7DOFWDT7OZGLD7EQEZUVOWUEMC`;
spending-limit policy `CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4` (lives to ~14 Nov); USDC SAC
`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` (issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`);
onboarding router: deploy ours (~2.5 XLM); facilitator OpenZeppelin Channels `https://channels.openzeppelin.com/x402`
(`stellar:pubnet`, fees sponsored, key from `/gen`), Vellar as keyless fallback; third-party seller for the video:
Stellar's `/x402-demo/api/protected/mainnet` (0.01 USDC). Costs: deploy 0.15, grant install ~0.2, delegated payment 0.015,
passkey payment 0.0012 XLM. Rules: invite-only signup on pubnet, no 10 USDC auto-fund, caps + kill switch on, never add a
Delegated signer to the account. Funding Kristjan provides: ~50 XLM and 25–115 USDC. Go/no-go at ~06:00 UTC: testnet
rehearsal green, one real 0.10 USDC settlement through OZ Channels on mainnet, caps tested, accounts funded. Judges stay on
testnet either way.

## Integration status (13:37 UTC)

- All streams have committed: A1 service (OAuth + passkey consent, ten tools, D1, WalletObject, owner pages, claim flow,
  Nod copy, network presets, caps, kill switch, invite codes), A2 `@hm/stellar` (full live testnet run incl. the claim with
  the smart account as sender), B site (pages, real-passkey e2e 8/8, invite-code fallback), C seller + seeds + probe +
  rehearsal runner.
- The local stage runs on the real chain. B's passkey flow created `CAKADCRBDPEYNNFVNQUWIMPUY53XP7DJUO6DXNNJAHJDIK5EWFSDSDIS`
  through the product and verified 10.00 USDC directly on the SAC. A1's real-chain rehearsal passed acceptance 4, 5, 6, 9;
  the first delegated transfer hit the 40 XLM fee ceiling at rent factor 96 (ceilings raised to 60/6 XLM), and the claim
  flow landed after that run.
- Testnet deploy: B deploys from a dedicated worktree at a committed SHA (c3f7b12 or later) with two fresh relayers
  (`GBCALSA3…`, `GAWYWVMH…`). An earlier one-off deploy from the main checkout (release 34a0b91) created the Worker and the D1
  database; its Alchemy state is copied into the worktree so the plan updates rather than recreates. URL:
  https://hack-meridian-testnet.kristjan-grm11775.workers.dev (MCP at `/mcp`).
- Open: owner approval of an over-allowance x402 purchase followed by the agent's retry; rent factor rising (47 → 96 today).

## First real-chain rehearsal (13:38 UTC, local stage at c3f7b12, `evidence/demo/2026-10-25T13-38-30-890Z/`)

| Acceptance test                                  | Result             | Evidence                                                                                                                           |
| ------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1 x402 purchase consumes the allowance           | PASS               | pull `646d95c9…` (40.7 XLM, relayer), settlement `1c680612…` (fee paid by x402.org); 5.00 → 4.90                                   |
| 2 over-allowance routed to the owner             | PASS               | 4 USDC needed the nod; execute refused                                                                                             |
| 3 forced over-limit rejected onchain             | REF                | S1 `3daf4b00…`                                                                                                                     |
| 4 passkey approval bound to recipient and amount | PASS               | dinner to Bob `8f9e79cb…`, 20 USDC exactly, allowance unchanged                                                                    |
| 5 repeat does not pay twice                      | PASS               | same payment id and receipt, Bob's balance unchanged                                                                               |
| 6 revoke blocks the next payment                 | PASS               | Unauthorized after revoke; rule removed (read from chain)                                                                          |
| 7 receipt only after settlement                  | FAIL (fee ceiling) | 2 USDC to Alice refused: enforce simulation needed 15.3 XLM vs the 6 XLM later-payment ceiling at rent factor 96; ceiling → 25 XLM |
| 8 trustline + payment in one transaction         | PASS               | Carol `8457e9cb…`                                                                                                                  |
| 9 relayer pays every fee, wallet holds no XLM    | PASS               |                                                                                                                                    |

## Testnet deployed (13:43 UTC)

Site https://hack-meridian-testnet.kristjan-grm11775.workers.dev, MCP https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp,
release `c80a786` from the deploy worktree `/srv/cache/hm26/deploy-testnet`. Health: chain mode testnet, relayers `GBCALSA3…`
and `GAWYWVMH…` (10,000 XLM each), treasury 210 USDC, rent factor 109.6. `smoke:testnet` 9/9; passkey e2e 8/8 with wallet
`CCDOHIGFC4Y2EYZWA66HULNXUI3PX3OD3WX27OKGPEHLRR3LDR3OBZG4` holding 10.00 USDC verified on chain. Testnet deploys stay with
the worktree: `git -C /srv/cache/hm26/deploy-testnet checkout --detach <sha>`, gate, plan, apply. Pending: fee ceilings
raised to 100 XLM first pull / 40 XLM later and redeployed; the Contacts page was still loading in the e2e screenshot.

## Status 15:05 UTC

- Service complete for the demo: fee ceilings follow the live rent factor (`ee61aef`; testnet at ~115× normal), revoke
  records remove_tx and sweep_tx (`7036c72`), over-allowance x402 approve-then-retry (`89d1b3c`). Env var list in the
  README (owner a3). One thematic track: Composed.
- Redeploy of testnet at `19e1c13` applying (additive migration 0003, fee ceilings, pre-judge files `/llms.txt`,
  `/robots.txt`, `/sitemap.xml`, OG/noscript index). C's single full testnet rehearsal follows, then Kristjan's own run in
  Claude.
- Stream C's agent hit an Opus rate limit; its work is committed; the rehearsal run resumes it or uses a smaller model.
- 16:00 UTC decision: the optional "run a sample agent" page for judges without Claude (A1 server-side runner against a
  service-owned demo wallet, rate-limited; B page). In only if the testnet rehearsal is green and rate limits allow.

## Deployed-stage rehearsal (15:04 UTC, release 19e1c13, `evidence/demo/2026-10-25T15-04-38-091Z/`)

7 of 9 acceptance tests pass on the public URL (2, 4, 5, 6, 8, 9; 3 by reference). Tests 1 and 7 failed on one cause
outside the wallet: at rent factor 219 an x402 settlement costs ~63k stroops, above x402.org's fee cap, so the seller's
facilitator refused (`invalid_exact_stellar_payload_fee_exceeds_maximum`). Seller fix `447c713`: OpenZeppelin Channels
first, fall back to the next facilitator when one refuses only on its own fee cap; verified settlement `ae4c60b2…`.
A confirming full run follows. Hashes: Alice 2 USDC `42c8aa3b…` (28.8 XLM fee, relayer), Bob 20 USDC via passkey
`2577fefc…`, Carol claim `9e2f5c16…`, rule removal `95c909b0…`, sweep `1975a39d…`. `scripts/demo/topup.ts` tops up a
wallet from the treasury (for the recording wallet). Service follow-ups: include the pull hash on failed purchases;
expose deploy and install hashes.

## Reference run: all nine acceptance tests pass on the public URL (15:12 UTC, `evidence/demo/2026-10-25T15-12-52-316Z/`)

Release 19e1c13 with the seller preferring OpenZeppelin Channels, 204 s end to end. Pull into the pocket `97847912…`
(91 XLM at rent factor 219, relayer), settlement `e3e62e07…` (fee paid by OpenZeppelin Channels), Alice `fb77bd0f…`,
Bob via passkey `fbfd200c…`, Carol claim `565b7f07…`, rule removed `55beab6d…`, sweep `00129674…`. Judge test path
section 3 carries this run. Next: redeploy HEAD (36f8466: failed-purchase accounting, lifecycle hashes, 600 XLM cap,
vault test fix), then the optional `/sample` page.

## Status 15:50 UTC

- Testnet at `0ca5495`: landing redesign (e6), llms.txt with the sample link (a3), `/sample` page live. The hard fee ceiling
  is 600 XLM in the stage env after a grant install hit the old 100 XLM ceiling at rent factor 278 (the consent page would
  have failed for judges). Treasury refilled to 405 USDC on the testnet exchange.
- `/sample`: a server-side run of the nine steps on Nod's own demo wallet (software passkey, encrypted under VAULT_KEY),
  judge-path amounts (Bob 5, Carol 1), guards: testnet only, one run at a time, 4 runs/hour, 1 per visitor per 10 min,
  treasury floor, kill switch. First public run sr_4f0bc683: 70 s, every step ok; Carol skipped (already onboarded), a
  self-reset is being added. Linked from README, llms.txt, deck slide 10 and the landing ("No Claude at hand?").
- Foundation session closed; deploys run from the worktree per `docs/DEPLOY.md`.
