# apps/web

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: true

## Project Notes

Follow the root [AGENTS.md](../../AGENTS.md) as well.

- The Foldkit source for the installed release is cloned read-only at `../../repos/foldkit` (gitignored, tag
  `foldkit@0.169.0`), so the paths `FOLDKIT.md` gives as `repos/foldkit/...` are `../../repos/foldkit/...` from here.
  If it is missing: `git clone --depth 1 --branch foldkit@0.169.0 https://github.com/foldkit/foldkit.git repos/foldkit`
  from the repository root. Never import from it.
- Two programs live here. **Browser**: `src/entry.ts` boots `src/main.ts` (Model, Messages, Commands, update, view);
  `src/api.ts` gives Commands the typed client for `@hm/api`. **Worker**: `src/worker.ts` answers `/api/*` through
  `src/server/` (Effect `HttpApiBuilder` handlers and services) and hands every other path to the static assets.
  `tsconfig.json` covers the browser and excludes the Worker; `tsconfig.worker.json` covers the Worker.
- The browser never imports `src/server/`, `@hm/counter-client` or anything holding a secret. It reaches the chain
  through the Worker's API.
- A new endpoint: add it to `packages/api`, implement it in a handler group in `src/server/app.ts` (a new service
  gets its own file and a fake in the tests), call it from a Command through `withApi`.
- Tests: `story.test.ts`/`scene.test.ts` beside the code they drive (happy-dom project `web`); Worker tests in
  `src/server/*.test.ts` (node project `worker`) call `makeApiHandler` with fake layers.
- Look at the result: `bun run dev`, then `bun run shots` from the repository root, and read the screenshots. The
  Foldkit devtools panel ("DEV" tab) and the `foldkit-devtools` MCP server show the live Model and Messages.
