# Deploying the testnet stage

Handed over by the foundation session (stream B) on 2026-10-25 15:35 UTC to the orchestrator session. Live: testnet at
`20963b3` on **https://testnet.trynod.si** (cutover 17:32 UTC at 3a63bd5: custom domain attached, ORIGIN/RP_ID bindings set,
URL sweep and W1 included; 17:39 UTC: every path worker-first so the old workers.dev host 301-redirects the landing and client
routes too; smoke 9/9 against the new host). The stage URL is https://testnet.trynod.si (MCP at `/mcp`); https://hack-meridian-testnet.kristjan-grm11775.workers.dev redirects there.

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
