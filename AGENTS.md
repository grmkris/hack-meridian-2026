# HackMeridian 2026: agent instructions

Master file; `CLAUDE.md` is a symlink to it. Nested instructions (load the ones you touch): [apps/web](apps/web/AGENTS.md),
[contracts](contracts/AGENTS.md).

**Nod**: a Stellar wallet inside AI chats, live on mainnet at trynod.si (judges' sandbox: testnet.trynod.si). The
HackMeridian submission closed 26 Oct 2026. **Nod moves into Sidequest v2** (`~/code/sidequestv2`); until that port is
done this repo is maintenance only: keep trynod.si running and fix what breaks, no new features (2026-10-30).

The product is specified in [docs/SPEC.md](docs/SPEC.md); the risky parts are proven in `spikes/` per
[docs/SPIKES.md](docs/SPIKES.md). Those two areas belong to the orchestrating session: read them, do not edit them
unless that is your task.

## Layout

| Path                      | What                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `apps/web`                | Foldkit SPA (`src/main.ts`) and the Cloudflare Worker (`src/worker.ts`, `src/server/`)  |
| `apps/web/alchemy.run.ts` | the only Alchemy file: stages `local` and `testnet`                                     |
| `packages/api`            | Effect `HttpApi` contract shared by browser and Worker (schemas only, browser-safe)     |
| `packages/counter-client` | generated TypeScript bindings for the counter contract; regenerate, never hand-edit     |
| `contracts/`              | Soroban Rust workspace; `deployments/testnet.json` is the public record of deployed ids |
| `scripts/`                | `stage` (Alchemy runner), `smoke`, `shots`, `typecheck`, `contract`                     |
| `spikes/`, `docs/`        | orchestrator-owned experiments and spec; outside the product gates                      |

## Pins (exact; bump one deliberately, rerun every gate)

Bun 1.4.2 · Node 24 · TypeScript 7.0.2 · Effect 4.0.5 · Foldkit 0.169.0 (`@foldkit/vite-plugin` 0.28.0) · Alchemy
**2.0.0-beta.83** · Vite 8.3.5 · Vitest 5.0.5 · oxlint 1.89.0 / oxfmt 0.74.0 · effect-tsrs 0.2.0 · soroban-sdk 29.0.1
(testnet and mainnet run protocol 29) · stellar-cli 28.1.0 · `@stellar/stellar-sdk` 16.4.1 in the generated bindings.

## Rules

- **Git: work on `main`; this checkout is shared** with the orchestrator, spike agents and other sessions. Commit each
  coherent green change with a pathspec, in one command: `git add <paths> && git commit -m "…" -- <paths>`. A plain
  `git commit` takes everything anyone staged (it happened here on 2026-10-25). Never `git stash`, `reset --hard`,
  `restore`, `checkout --`, `clean`, `add -A`/`.`. A red gate in a file you did not touch is someone's live edit.
- **Expensive commands go through `heavy`** (`heavy bun run check`); exit 75 means retry later. Never pipe `heavy`.
- **Effect**: read `node_modules/effect/AGENTS.md` and the `effect` skill. Services and Layers, tagged errors, Schema
  at boundaries, `Config` instead of `process.env`, no `any`, assertions only with a `// SAFETY:` line.
- **Foldkit**: read `apps/web/FOLDKIT.md`. The browser imports `@hm/api` and pure code only; anything with a secret,
  a binding or an SDK that signs runs in the Worker.
- **Alchemy** only in `apps/web/alchemy.run.ts`, run only through `scripts/stage.ts`; read the `alchemy` skill.
- **Stellar**: testnet only, never mainnet. Keys never enter the repo: the deployer is the stellar CLI identity
  `hm-deployer` (`~/.config/stellar`); public keys, contract ids and transaction hashes are fine to commit.
- **Secrets** come from `~/.config/secrets.env` through `scripts/stage.ts` and are bound as Worker secrets with
  `Config.Redacted`. Never print, log or commit one; the repository is public.
- Say which evidence you have: unit, local workerd, or testnet; onchain claims carry a `stellar.expert` link.

## Verification loop

1. While working: `bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run contracts:test`.
2. Before each commit: `heavy bun run check` (format, skills/MCP drift, lint, typecheck, tests, clippy, cargo tests,
   build). It must be green for the paths you own.
3. Running app: `bun run dev` (long-running, not through `heavy`), then `bun run smoke:local` and `bun run shots`
   (read the PNGs in `.local/shots/`). With the app open, the `foldkit-devtools` MCP shows Model and Message history.
   `bun scripts/site-e2e.ts local` walks the owner's path with a real WebAuthn ceremony (Chrome's virtual
   authenticator): create a wallet, every page, sign out, sign back in; screenshots in `.local/e2e/`. Site work
   without the service: `VITE_BACKEND=fixture bun run --cwd apps/web dev` (or `fixture-signed-out`).
4. Contract change: `bun run contracts:test`, `bun run contracts:deploy` (testnet), `stellar contract invoke … --id
   hm-counter`, then `bun run contracts:bindings` and commit the regenerated package with the deployment record.
5. Deployed: `bun run deploy:testnet`, `bun run smoke:testnet`, `bun run shots testnet`.
6. UI work ends with the `break-ui` and `make-interfaces-feel-better` skills; a risky change ends with
   `thermo-nuclear-review`.

## Skills and MCP

`.agents/skills` and `.mcp.json` are canonical; `bun run agents:sync` links skills into `.claude/skills` and writes the
Codex and Cursor configs; `bun run agents:check` (part of `check`) fails on drift. Vendored skills keep their pinned
source, licence and hash in `.agents/skills/sources.json`; change one only with `repoagents skills rehash`.

| Skills                                                                                                                                   | Use for                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `foldkit`, `generate-program`, `audit-program`                                                                                           | Foldkit app code and review           |
| `effect` (local), `effect-ts`                                                                                                            | Effect services, schemas, errors      |
| `alchemy` (local), `learn-alchemy`, `workers-best-practices`, `durable-objects`                                                          | Worker and infrastructure             |
| `stellar-smart-contracts`, `stellar-dapp`, `stellar-assets`, `stellar-data`, `stellar-standards`, `stellar-agentic-payments`             | Soroban, SDK, SAC, RPC, SEPs, x402    |
| `rat-stack-mode`, `add-a-capability`, `add-a-store`, `test-behaviour`, `investigate-a-failure`                                           | design, persistence, tests, debugging |
| `frontend-design`, `make-interfaces-feel-better`, `good-css`, `mobile-native`, `break-ui`, `thermo-nuclear-review`, `unslop`, `grilling` | UI, copy and review                   |
| `hallmark`, `animate`, `apple-design`, `animation-vocabulary`, `find-animation-opportunities`, `review-animations`, `apple-web-app`      | landing art direction, motion, iOS    |

MCP servers: `stellar-raven` (Stellar docs and live ecosystem data, OAuth), `cloudflare` (account, logs, docs; OAuth),
`rat-stack` (Effect + Alchemy rules and lore; public), `mysi` (Kristjan's MyApps tools; OAuth), `foldkit-devtools`
(the running app's Model and Messages; stdio, local only).

## Commands

```sh
bun install
bun run dev                    # local stage: http://localhost:18960
bun run smoke:local            # HTTP acceptance of the running stage
bun run shots                  # phone + desktop screenshots → .local/shots/
heavy bun run check            # every gate
bun run contracts:deploy       # build + deploy the counter to testnet, record the id
bun run contracts:bindings     # regenerate packages/counter-client from the wasm
bun run deploy:testnet         # deploy the Worker (commit first: health reports the commit)
```
