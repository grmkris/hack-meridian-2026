---
name: alchemy
description: Change or inspect this repository's Cloudflare infrastructure, Worker bindings and stages (apps/web/alchemy.run.ts, scripts/stage.ts, Alchemy 2.0.0-beta.83).
---

# Alchemy here

`apps/web/alchemy.run.ts` is the only file that imports Alchemy. It declares one `Cloudflare.Website.Foldkit` (the
Foldkit build plus `src/worker.ts`) and the Worker's bindings. Learn the model from the `learn-alchemy` skill; this
page is what differs here.

- **Run it only through `scripts/stage.ts`** (`bun run dev`, `plan:testnet`, `deploy:testnet`, `destroy:testnet
  --confirm`). It builds the child environment from scratch: inherited `CLOUDFLARE_*`/`HM_*`/`ALCHEMY_*` values are
  dropped, Bun's `.env` autoload is off, and the Cloudflare token is read for cloud runs only. Never print the token.
- **Stages**: `local` (alchemy dev, http://localhost:18960, placeholder credentials) and `testnet`
  (https://hack-meridian-testnet.kristjan-grm11775.workers.dev). Any other stage dies in the stack.
- **State is local** (`apps/web/.alchemy/`, gitignored) for every stage. The account's shared Cloudflare state store
  holds myapps', goblin's and swarmm's stacks, has no lock, and changes version with Alchemy; this repository never
  uses it. Deploy testnet from this checkout only, one deploy at a time.
- **Pin**: `alchemy` is exactly `2.0.0-beta.83` (what myapps, goblin and swarmm run). Do not take the "beta.84 is
  available" prompt; a bump is its own change with every gate rerun.
- **Settings reach the Worker as bindings** in `env: {}` and are read through `Settings` (Effect `Config`), never
  `process.env`. Secrets are `Config.Redacted('NAME')` in the stack, which Alchemy binds as Worker secrets.
- **Routing**: `assets.runWorkerFirst: ['/api/*']`; everything else is a built asset or, for a client route, the SPA's
  `index.html`. Add a prefix there (for example `/mcp`, `/.well-known/*`) when the Worker must answer it.
- **Rebuilds** are memoised over `memo.include`; add a path there when the build starts depending on it.

Gotchas already paid for on this box:

- workerd in beta.83 supports compatibility dates up to **2026-10-09**; a newer date fails `alchemy dev`.
- `nodejs_compat` is the default since 2026-08-04; do not list it.
- Alchemy needs `@effect/platform-bun` beside it (a peer that Bun does not install by itself).
- A Worker `domain` must be `{ name }` only, and D1 databases need `readReplication: { mode: 'disabled' }`, or
  `alchemy drift` reports them on every run (myapps).
- Unbinding a Durable Object namespace deletes the class and its data. Read every plan that says delete, replace or
  unbind before deploying it.
- `alchemy dev` logs `Fallback service failed to fetch module … node:process`; requests are unaffected.

Report local checks, an inspected plan, a deploy and its smoke (`bun run smoke:testnet`) as separate evidence. Loading
this skill does not authorize a deploy.
