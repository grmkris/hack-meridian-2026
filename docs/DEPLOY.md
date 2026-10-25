# Deploying the testnet stage

Plans and queues live in the release plan (.local/brainstorm/FINAL-REVIEW.md §K, tailnet); procedures below remain valid.

**Deploys: session A ("ops and hardening") only, since 19:10 UTC 2026-10-25**, testnet and mainnet, from the worktree
below; mainnet only on the orchestrator's explicit go, never during a recording.

Live: **testnet at `5253df0`** (19:12 UTC, deposit-address service + migration 0007) on https://testnet.trynod.si (MCP at
`/mcp`; the workers.dev host redirects there); **mainnet at `5253df0`** (19:24 UTC) on https://trynod.si. Dated sections
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
