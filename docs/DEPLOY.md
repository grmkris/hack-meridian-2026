# Deploying the testnet stage

Handed over by the foundation session (stream B) on 2026-10-25 15:35 UTC to the orchestrator session. Live: testnet at
`0ca5495` (deployed 15:48 UTC: e6's landing redesign 3845f15/754d538, a3's llms.txt with the /sample link, the /sample page
with the 600 XLM hard ceiling from 347b7ea/1506dbb; smoke 9/9, llms.txt byte-identical; rent factor ~290). The stage URL is https://hack-meridian-testnet.kristjan-grm11775.workers.dev (MCP at `/mcp`).

## The deploy worktree is the only place a testnet deploy runs

`/srv/cache/hm26/deploy-testnet`, a git worktree detached at the deployed SHA, with its own `node_modules`,
`apps/web/.env.testnet` (mode 600, copied unread from the main checkout with `install -m 600`), and the **authoritative
Alchemy state** in `apps/web/.alchemy/state/hack-meridian/testnet`. The main checkout's copy of that state is stale
(from before `19e1c13`). Never deploy from the main checkout; never delete the worktree. If a secret is added to the main
checkout's `.env.testnet`, copy the file again the same way and never read it.

## Procedure

```sh
W=/srv/cache/hm26/deploy-testnet
test -z "$(git -C $W status --porcelain)" && git -C $W switch -q --detach <SHA>   # 1. pin (not `checkout --detach`: a deny rule catches it)
cd $W && bun install --frozen-lockfile                                            # 2.
heavy bun run check                                                               # 3. retry on exit 75; never pipe heavy
bun run plan:testnet                                                              # 4. stop on any delete or replace
bun run deploy:testnet                                                            # 5. log must show "deletedClasses":[]
curl -s https://hack-meridian-testnet.kristjan-grm11775.workers.dev/api/health   # 6. .release equals the SHA
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
- ~~e6's landing restyle~~ deployed in `0ca5495`. Queued: e6's polish `459fd24` (landing.css/landing.ts only) and the
  sample runner's Carol reset (pending commit). Original restyle conditions: `apps/web/src/landing.css`, `src/assets/`, `landing-copy.ts`, the `welcome.ts` view
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
