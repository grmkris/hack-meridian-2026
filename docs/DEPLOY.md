# Deploying the testnet stage

Plans and queues live in the release plan (.local/brainstorm/FINAL-REVIEW.md §K, tailnet); procedures below remain valid.

**Deploys: session A ("ops and hardening") only, since 19:10 UTC 2026-10-25**, testnet and mainnet, from the worktree
below; mainnet only on the orchestrator's explicit go, never during a recording.

Live: **testnet at `3d4364f`** (19:56 UTC: claim link v2 and migration 0009 over `9a965a3`) on https://testnet.trynod.si
(MCP at `/mcp`; the workers.dev host redirects there); **mainnet at `3d4364f`** (20:04 UTC) on https://trynod.si. Dated sections
below are the history.

## The deploy worktree is the only place a testnet deploy runs

`/srv/cache/hm26/deploy-testnet`, a git worktree detached at the deployed SHA, with its own `node_modules`,
`apps/web/.env.testnet` (mode 600, copied unread from the main checkout with `install -m 600`), and the **authoritative
Alchemy state** in `apps/web/.alchemy/state/hack-meridian/testnet`. The main checkout's copy of that state is stale
(from before `19e1c13`). Never deploy from the main checkout; never delete the worktree. If a secret is added to the main
checkout's `.env.testnet`, copy the file again the same way and never read it.

## Procedure

```sh
W=/srv/cache/hm26/deploy-testnet
test -z "$(git -C $W status --porcelain)" && git -C $W switch -q --detach <SHA>   # 1. pin (not `checkout --detach`: a deny rule catches it); .env.testnet in the worktree already carries ORIGIN/RP_ID = testnet.trynod.si
cd $W && bun install --frozen-lockfile                                            # 2.
heavy bun run check                                                               # 3. retry on exit 75; never pipe heavy
bun run plan:testnet                                                              # 4. stop on any delete or replace
bun run deploy:testnet                                                            # 5. log must show "deletedClasses":[]
curl -s https://testnet.trynod.si/api/health                                      # 6. .release equals the SHA
bun run smoke:testnet                                                             # 7. 9 checks → .local/smoke-testnet.json
```

8. Content checks: `curl …/llms.txt | cmp - apps/web/public/llms.txt`; grep the landing bundle (`/assets/index-*.js`
   linked from `/`) for the proof hashes; check each proof hash on Horizon
   (`horizon-testnet.stellar.org/transactions/<hash>` → `.successful`) before it ships.
9. `bun scripts/site-e2e.ts testnet` only when needed: each run creates a wallet the treasury funds with 10 USDC.

Rules: a new migration must be additive; a new secret appears as a new binding and must also be in `SECRETS` in
`apps/web/alchemy.run.ts` and in `.env.testnet`; every deploy restarts the Durable Objects, so hold the apply while a
rehearsal or a recording is in flight. `scripts/stage.ts` appends `-dirty` to the release if `apps`, `packages` or
`contracts/deployments` are dirty; the worktree is always clean.

## Queue (main is past `36f8466`)

- ~~`a61dd15`~~ deployed in `b1a960b` (15:36 UTC).
- ~~e6's landing restyle~~ deployed in `0ca5495`. e6's polish `459fd24` and the sample runner's Carol reset `4dd5d42` deployed 15:53 UTC. Original restyle conditions: `apps/web/src/landing.css`, `src/assets/`, `landing-copy.ts`, the `welcome.ts` view
  markup, the `index.html` font load. Agreed conditions: unchanged test ids, the "Wallet name" label, and the alert and
  status roles; no 390 px overflow and no console errors (`bun run shots` checks both); AA contrast and focus rings on
  the dark hero; motion only behind `prefers-reduced-motion`; a3's meta and noscript untouched. Verify with
  `bun scripts/site-e2e.ts local` and `bun run shots testnet` after the deploy.
- ~~`/sample` page~~ deployed (347b7ea, amounts 1506dbb): new Durable Object `SAMPLE_RUNNER`, switch `SAMPLE_ENABLED`,
  `/sample` in runWorkerFirst; first public run `evidence/sample/sr_4f0bc683de9afffaa85fe224.json`.

## Ownership after the handoff

- Testnet deploys: the orchestrator session (`hack-meridian-2026-b7`).
- Former stream B files, now without a dedicated owner: `apps/web/src/{main,entry,route,problem,format}.ts`,
  `src/page/{home,connections,contacts,receipts,welcome}.ts` with their stories and scenes, `src/backend/**`,
  `src/view/**`, `styles.css`, `scripts/{smoke,shots,site-e2e,stage,typecheck,contract}.ts`. e6 edits the `welcome.ts`
  views for the restyle. Open optional item: show the invite field up front when `/api/health` reports
  `invite_required` (mainnet only).

## Stream "nod-mcp-apps-wallet" (session -14, Kristjan's go 16:00 UTC)

Adds MCP Apps cards, MCP Events, payment requests and a 2026-07-28 MCP lane. Owns `apps/web/src/server/{mcp,mcp-tools,
mcp-apps,mcp-modern,requests}.ts`, `server/events/**`, `server/cards/**`, `src/card/**`, `vite.cards.config.ts`,
migrations `0004_events.sql` + `0005_requests.sql`, `plugins/nod/**`, `scripts/events-check.ts`; additive hunks in the
shared service files, protocol and stellar packages, root `package.json` (cards scripts in `check`). No bindings, secrets,
crons or route prefixes. Deploys testnet itself per this document, twice (~23:00 UTC and 05:00–07:00 UTC), announced 15
minutes before; holds for a recording or a rehearsal; final deploy verified by 07:00 UTC, rollback = re-pin `4dd5d42`.
Before each deploy: gate green, local real-chain rehearsal s1–s11 and sample tests; after: release, smoke 9/9, `/sample`
run or testnet rehearsal with hashes.

## Queue update 16:45 UTC

Main's history now interleaves the MCP-Apps session's cards/events commits (migrations 0004/0005) with the landing's
pass-2 commit `07ef929`, so every testnet deploy from main needs that session's pre-deploy gate first (clean-worktree
check, fresh local stage from the worktree on the real chain, rehearsal s1–s11, sample tests, events-check). Next deploy:
**one combined deploy at the MCP-Apps session's SHA, ~17:30 UTC**, carrying landing part 1 (and part 2 if committed),
the mainnet agent's four small fixes, and, if the trynod.si zone is active by then, the testnet cutover (ORIGIN and RP_ID
lines set in both `.env.testnet` copies before the pin; expect two binding updates and the hostname in
`plan:testnet --detailed --include Web`). Post-deploy: docs/DEPLOY.md checks plus docs/DOMAIN.md verification, then the
pitch session's URL sweep, then Kristjan re-adds the connector and records. The local dev stage on :18960 is being
restarted by that session (migration 0004 needs a fresh start).

## 17:45 UTC: identity on chain

`GET /.well-known/stellar.toml` is served by the Worker per stage (`apps/web/src/server/stellar-toml.ts`: text/plain,
CORS `*`, 5-minute cache, ACCOUNTS = the stage's relayers and treasury). `home_domain = testnet.trynod.si` is set on
`GBCALSA3…` (`5e7d299a…`), `GAWYWVMH…` (`653755e9…`) and `GB4F3NUA…` (`c1b51014…`) via `scripts/mainnet/home-domain.ts
--network testnet`. Mainnet: `HM26_MAINNET_GO=yes bun scripts/mainnet/home-domain.ts --network pubnet` after the
mainnet stage serves its own file. The box's resolver (netcup) had negative-cached the name from before the zone was live; it resolves now (no hosts entry). Note: the apex `trynod.si` and `www.trynod.si` have no DNS records until the mainnet stage deploys with its custom domain; until then the apex does not resolve.

## 18:02 UTC: mainnet stage live

`https://trynod.si` (+ `www`, 301 to the apex) at release `833091a` from the same deploy worktree (`bun scripts/stage.ts
plan:mainnet` / `deploy:mainnet`; its Alchemy state is `apps/web/.alchemy/state/hack-meridian/mainnet` in the worktree,
secrets `apps/web/.env.mainnet` copied unread with `install -m 600`). Health: stage mainnet, network pubnet, invite
required, payments on, fee ceilings 1 XLM, two relayers, treasury. OAuth issuer `https://trynod.si`, `stellar.toml` 200,
landing 200, `/mcp` 401 gate, `/sample` present but disabled on pubnet. Plan was 2 creates + 27 bindings, no deletes.

## 18:18 UTC: mainnet open signup

`https://trynod.si` at `24969ee`: `INVITE_REQUIRED=false` (Kristjan, 18:17 UTC: no invite on mainnet), payment caps
lifted to 1,000,000 USDC on both stages (`c9f7792` deploy). Wallet-creation rate caps and the "Add money" card follow in
the next deploy; the W1 nod line is being reversed to one number (allowance = total; past it, passkey approval each time,
no upper limit) in the MCP-Apps session, with the demo beats restored on my side. Testnet is at `c9f7792`.

## 18:28 UTC: both stages at `9fc080f`

Testnet (`https://testnet.trynod.si`) and mainnet (`https://trynod.si`) are at `9fc080f`: one-number allowance (`1b04511`;
no nod line, no per-payment cap on approved payments), the demo beats sized to a 10 USDC wallet (`71f7a71`), wallet-creation
caps (`05614ff`; testnet 20/200, mainnet 3/30 per hour), the Home "Add money" card with the `C…` address and a QR (`98d42f0`),
and a wallet's network taken from the stage with a one-time backfill (`9fc080f`; the mainnet wallet's badge read Testnet).
Gate green in the worktree, two Alchemy updates (RELEASE binding only), smoke 9/9 on testnet, `/sample` 200, mainnet health
invite off / payments on. Deploys went 1b04511 (18:25) then 9fc080f (18:27); the intermediate `c9f7792` and `24969ee`
releases are superseded.

## 19:10 UTC: the orchestrator session closes; deploys move to the MCP-Apps session

Kristjan closes the orchestrator session after the mainnet run (`evidence/mainnet/claude-run-2026-10-25.md`). From here
the **MCP-Apps session (`nod-mcp-apps-wallet`) owns every deploy, testnet and mainnet**, from the same worktree
`/srv/cache/hm26/deploy-testnet` (both stages' Alchemy state and both `.env` files live there; `plan:mainnet` /
`deploy:mainnet` as in "18:02 UTC: mainnet stage live"). Rules unchanged: pin a commit that is green on main, frozen
install, `heavy bun run check`, plan with no deletes or replaces, deploy, smoke 9/9 on testnet, health release match,
Live line here with a pathspec commit. Mainnet only after the same commit has served testnet green, and never during a
recording.

State at close: testnet at `c54a331` (MCP-Apps deploy 18:45 UTC), mainnet at `9fc080f`. Pending, in order:

1. **Testnet: HEAD (≥ `3473b0f`)** carries the deposit-address service and migration `0007_deposit_addresses.sql`
   (additive; no new bindings or secrets; `DEPOSIT_ROUTER_ID` optional). After it, the Add money card can code against
   `GET /api/wallet/deposit-address` and `POST /api/wallet/sweep`; pubnet answers `404 deposit_unavailable` until a
   router is deployed there (Kristjan's go, needs ~10 XLM more on relayer A).
2. **Mainnet: the same HEAD** once testnet is green: brings `4a233ba` (a declined or cancelled URL request returns the
   plain result; on `9fc080f` claude.ai shows Failed) and the deposit code (inert on pubnet). Check on the first request
   after the deploy that `store.ts` `backfillNetwork` actually runs: on `9fc080f` it did not (the mainnet rows kept
   `stellar:testnet` until the orchestrator ran the two UPDATE statements by hand on D1 `hack-meridian-mainnet-wallet`
   at 18:43 UTC); the data is right now, the code path is unverified.
3. **Before recording:** `bun scripts/demo/probe.ts --target testnet --save` green (the 19:05 UTC run is in
   `evidence/probe/`), and no deploy from the moment Kristjan starts recording.
4. **Mainnet deposit router** only on Kristjan's explicit go: `scripts/mainnet/router-deploy.ts` pattern for
   `contracts/deposit`, then `DEPOSIT_ROUTER_ID` in `.env.mainnet`, then a deploy.

Open findings for the MCP lane (not blocking): the post-nod tool result should say the owner approved with the
passkey; the post-claim result should restate the recipient's readiness; the approval page's "they accept on the claim
link first" sentence has the order backwards (approve, then accept, one transaction).

## 19:12 UTC: testnet at `5253df0` (session A)

Session A took the deploy seat: worktree clean at `c54a331`, no-op `plan:testnet` "no changes", no-op `plan:mainnet`
RELEASE only. Pinned `5253df0` (main HEAD: `3473b0f` deposit-address service, migration `0007_deposit_addresses.sql`),
frozen install, `heavy bun run check` green in the worktree, plan `[WalletDb] update` + `[Web] update` +
`[Web/RELEASE] update` (no delete, no replace), deploy `"deletedClasses":[]`, `/api/health` release `5253df02…`, rent
factor 0.1, treasury 235.5 USDC, relayers 9,032 / 8,960 XLM. Checks on this release (testnet):

- `bun run smoke:testnet`: 9/9 (`evidence/probe/smoke-testnet-2026-10-25T19-12-49Z.json`).
- `scripts/events-check.ts --target testnet`: 8/8, settlement `a00cc841…`
  (https://stellar.expert/explorer/testnet/tx/a00cc84120cc7999970bf0b7a07ec4647460ccaa437ec0047fd4e95142841ad8).
- `scripts/claude-code-check.ts --target testnet`: 7/7 (fresh Claude Code, CIMD + PKCE, new passkey wallet,
  `wallet_overview` and `payment_prepare` inside the allowance; `.local/claude-code-check/2026-10-25T19-13-16-740Z/`).
- `scripts/demo/rehearse.ts --target testnet`: s1–s11 green, acceptance 1, 2, 4–9 PASS, 3 REF, 133 s
  (`evidence/demo/2026-10-25T19-14-24-616Z/`; hashes in `evidence/JUDGE-TEST-PATH.md` section 3, each `successful` on
  Horizon).
- `scripts/demo/probe.ts --target testnet --save`: all green, one warn (no saved connection for tools/list)
  (`evidence/probe/2026-10-25T19-18-16-039Z.json`).

Rollback: re-pin `c54a331` (migration 0007 is additive; the table stays).

Post-deploy checklist additions (session A): on every mainnet deploy, check on the first request that `store.ts`
`backfillNetwork` ran (`wallets.network` and `contact_destinations.network` all `stellar:pubnet` on D1
`hack-meridian-mainnet-wallet`; the code logs only a failure, "network backfill failed", so read the rows); on `9fc080f`
it did not.

## 19:24 UTC: mainnet at `5253df0` (session A, orchestrator's go)

Same worktree, same SHA as the 19:12 testnet deploy. `plan:mainnet`: `[WalletDb] update` (migration 0007, additive) +
`[Web] update` + `[Web/RELEASE] update`, no delete, no replace; deploy `"deletedClasses":[]`; `__alchemy_migrations`
shows `0007_deposit_addresses.sql` applied 19:23:47 UTC, `deposit_addresses` empty. `/api/health` (mainnet): release
`5253df02…`, network pubnet, `invite_required` false, payments on, fee ceilings 1 / 1 XLM, relayers 27.0 and 10.0 XLM,
treasury 0 USDC / 2.96 XLM. Read-only probe against `https://trynod.si`: OpenZeppelin Channels `/supported` exact on
pubnet, mainnet seller 402, OAuth metadata and the `/mcp` 401 challenge green; red only on the testnet funding floors
(relayers < 500 XLM, treasury < 50 USDC), which do not apply to mainnet. `GET /api/wallet/deposit-address` without a
session is 401 (session first, by design); the 404 `deposit_unavailable` for a signed-in pubnet wallet is covered by
`apps/web/src/server/deposit.test.ts`, not exercised live (no mainnet wallet created). No rehearsal on mainnet.

Backfill check: D1 `hack-meridian-mainnet-wallet` has every `wallets` (1) and `contact_destinations` (3) row on
`stellar:pubnet`, but those rows were fixed by hand at 18:42 UTC, so they prove nothing about the code. D1 query
analytics show no `UPDATE wallets SET network = ? WHERE network <> ?` from the Worker on either stage's database since
`9fc080f` (the hand-run literal UPDATE at 18:42 does show; analytics are sampled, so a strong hint, not proof), and the
Worker logged no "network backfill failed". Open: whether `networkBackfill` runs at all (session A item 5, on local
workerd).

## 19:30 UTC: testnet at `31a84de` (session A, orchestrator's go)

Ten commits over `5253df0`: C's Worker pages (`0e4c5e0`: consent, approval, revoke, claim; self-hosted fonts under
`public/fonts`, CSP `font-src 'self'`) and D's served files (`31a84de`: llms.txt, sitemap, robots, index meta). No
migration, no binding. Frozen install, `heavy bun run check` green in the worktree, plan `[Web] update` +
`[Web/RELEASE] update` only, deploy `"deletedClasses":[]`, health release `31a84de0…`. Checks (testnet):

- smoke 9/9 (`evidence/probe/smoke-testnet-2026-10-25T19-30-28Z.json`); `/llms.txt` byte-identical to
  `apps/web/public/llms.txt`; the three `/fonts/*.woff2` 200 `font/woff2` at their file sizes; `robots.txt` and
  `sitemap.xml` name both hosts.
- events-check 8/8, settlement `d46c9395…`
  (https://stellar.expert/explorer/testnet/tx/d46c9395c2ba2db854dbd0b39cfd3766512b73b9b356e06522828b3720dc197b).
- claude-code-check 7/7 (`.local/claude-code-check/2026-10-25T19-30-53-155Z/`).
- rehearsal s1–s11 green, acceptance 1, 2, 4–9 PASS, 3 REF; the new consent page renders in the real OAuth flow
  (`evidence/demo/2026-10-25T19-31-58-574Z/consent.png`); seven hashes `successful` on Horizon, e.g. the claim
  https://stellar.expert/explorer/testnet/tx/6ab5cdc27c18d2fd1edee689e57eda3a0387d14deb89d15725257240615d09a5.
  The judge path keeps the 19:14 run as its reference (README and submission cite it).
- probe all green, 1 warn (`evidence/probe/2026-10-25T19-35-39-964Z.json`).

Rollback: re-pin `5253df0`.

## 19:37 UTC: mainnet at `31a84de` (orchestrator's go)

Plan `[Web] update` + `[Web/RELEASE] update` only; deploy `"deletedClasses":[]`. `https://trynod.si/api/health`: release
`31a84de0…`, pubnet, invite off, payments on, relayers 27.0 / 10.0 XLM, treasury 0 USDC. `/llms.txt` byte-identical to the
repository file; the three `/fonts/*.woff2` 200 `font/woff2`. Backfill: still no Worker `UPDATE … SET network` in the
mainnet D1 analytics after the 19:24 deploy's first requests.

## 19:39 and 19:41 UTC: testnet at `d221e51`, then `9a965a3` (orchestrator's goes)

`d221e51` (B's deposit-first signup `405498e` with migration `0008_wallet_activations.sql`, C's tokens `b7269f0`, Home's
Add money `758b74d`): gate green, plan `[WalletDb] update` + `[Web] update` + RELEASE, deploy `"deletedClasses":[]`,
0008 applied 19:38:48 UTC (`wallet_activations` exists), smoke 9/9, events-check 8/8 (`f2e3befe…`). The full check set
moved to the next deploy, two minutes later:

`9a965a3` (adds C's Connections and header `93049bf` and D's landing `9a965a3`; no migration): gate green, plan `[Web]
update` + RELEASE, deploy `"deletedClasses":[]`, health release `9a965a3a…`.

- smoke 9/9 (`evidence/probe/smoke-testnet-2026-10-25T19-41-16Z.json`).
- `bun scripts/landing-shots.ts testnet`: 9 looks PASS (no page or console errors, no overflow, etchings draw); the hero
  badge reads "Stellar testnet", the connector line `https://testnet.trynod.si/mcp`.
- events-check 8/8, settlement
  https://stellar.expert/explorer/testnet/tx/c872ed5214070f2acf1c897c4b3ecce8520c85988d2b23515000c38f8688f929.
- claude-code-check 7/7 (`.local/claude-code-check/2026-10-25T19-43-24-170Z/`).
- rehearsal s1–s11 green, acceptance 1, 2, 4–9 PASS, 3 REF (`evidence/demo/2026-10-25T19-44-34-505Z/`; seven hashes
  `successful` on Horizon); Connections after the revoke shows the two-step notice with "Remove the rule" and the
  header pill "Stellar Testnet" (`connections-revoked.png`).
- `bun scripts/site-e2e.ts testnet`: 8/8 (new wallet funded 10 USDC by the SPA signup, every page, sign out, sign back
  in); Home shows the wallet balance and "What your AI may spend", and Add money offers "Get a deposit address" (not
  pressed live; B's gate covers it).
- probe all green, 1 warn (`evidence/probe/2026-10-25T19-48-59-754Z.json`). Treasury 166.5 USDC.

Rollback: re-pin `31a84de` (0008 is additive; the table stays).

## 19:50 UTC: mainnet at `9a965a3` (orchestrator's go)

Plan `[WalletDb] update` (0008) + `[Web] update` + RELEASE, deploy `"deletedClasses":[]`; 0008 applied 19:50:07 UTC on
`hack-meridian-mainnet-wallet`. Health: release `9a965a3a…`, pubnet, invite off, payments on, relayers 27.0 / 10.0 XLM,
treasury 0 USDC. `/llms.txt` byte-identical. `bun scripts/landing-shots.ts https://trynod.si`: 9 looks PASS; the rendered
landing reads "Stellar mainnet", the hero connector `https://trynod.si/mcp`, Try it the testnet connector
`https://testnet.trynod.si/mcp`, and the seven proof rows link to `stellar.expert/explorer/public` (each `successful` on
Horizon pubnet). No wallet created; "not available on this network yet" for the deposit address stays unit-covered.

## 19:56 UTC: testnet at `3d4364f` (HEAD `7f4c60f` was red)

HEAD failed the gate at `cards:check`: `7522620` (C's card "Send this link" state) committed a `card.html` that no
committed source builds (bisected in a clean worktree: `3d4364f` "up to date", `7522620` "stale"). Deployed the last
green commit that carries B's claim link v2 (`16426ce`, migration `0009_claim_links.sql`) and D's deck: gate green, plan
`[WalletDb] update` + `[Web] update` + RELEASE, deploy `"deletedClasses":[]`, 0009 applied 19:56:25 UTC (`claim_links`
exists), health release `3d4364f0…`.

- smoke 9/9 (`evidence/probe/smoke-testnet-2026-10-25T19-56-52Z.json`).
- tools/list (saved agent): the fifteen tools in order; `payment_prepare` gains only the optional `recipient_name`
  (protocol diff 4 lines) → `evidence/tools/tools-list-testnet-3d4364f.json`.
- `payment_prepare` with recipient "new", recipient_name "Jan", 0.10: a claim link
  `https://testnet.trynod.si/claim/cl_cba5…` (page 200, "Jan, 0.10 USDC for you"), nothing paid; an unknown
  `/claim/cl_0123…` answers a 404 page.
- events-check 8/8 (`d5cb7e1c…`); claude-code-check 7/7.
- rehearsal s1–s11 green, acceptance 1, 2, 4–9 PASS, 3 REF (`evidence/demo/2026-10-25T19-58-47-467Z/`); s10 (the
  `/claim/pi_…` path) https://stellar.expert/explorer/testnet/tx/a230a0fec834d4e6fde05f8983085ca1316dcc6f1a32d1def159ac34e50b3854.
- probe all green, 1 warn (`evidence/probe/2026-10-25T20-02-31-251Z.json`). Treasury 85.5 USDC.

Rollback: re-pin `9a965a3` (0009 additive).

## 20:04 UTC: mainnet at `3d4364f` (orchestrator's go)

Plan `[WalletDb] update` (0009) + `[Web] update` + RELEASE, deploy `"deletedClasses":[]`; 0009 applied 20:03:50 UTC
(`claim_links` exists; still one wallet, none created). Health release `3d4364f0…`, pubnet, invite off, payments on.
`/llms.txt` identical; unknown `/claim/cl_0123…` → 404 "Not found · Nod"; anonymous `POST /mcp` 401. tools/list needs a
mainnet connection (none made); same build as the 19:56 testnet list.
