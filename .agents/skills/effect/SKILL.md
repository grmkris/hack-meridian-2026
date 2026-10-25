---
name: effect
description: This repository's Effect 4 conventions for services, errors, schemas, config and tests; read before writing or reviewing Effect code here.
---

# Effect here

Read `node_modules/effect/AGENTS.md` first: it is Effect 4.0.5's own guide, and the installed `.d.ts` beats memory of
Effect 3. `effect-ts` (vendored) covers the library in general; this page is the house rules.

- Services are `class X extends Context.Service<X, { … }>()('hm/X')` with a `static readonly layer`; operations return
  `Effect`s with typed errors; a fake is `Layer.succeed(X, { … })`.
- Errors are tagged (`Schema.TaggedError`), never `extends Error`. Branch with `catchTag`/`catchTags`, `Match.tags` or
  `Predicate.isTagged`, never `_tag ===`.
- Decode untrusted input with Schema at the boundary (`decodeUnknown*`). A type assertion needs a `// SAFETY:` line;
  prefer a decode. No `any`.
- Settings come through `Config`, never `process.env` (the Worker: `Settings`, from its bindings).
- Inside an Effect use `Clock`, `Effect.log*`, `Effect.sleep`, `HttpClient` and `Random`, not `Date`, `console`,
  timers, `fetch` or `Math.random`. Calls into an SDK that returns a Promise go through `Effect.tryPromise` with a
  tagged `catch` and a timeout.
- Shared contracts live in `packages/api` (Effect `HttpApi`): the Worker implements them with `HttpApiBuilder`, the
  browser calls them with `HttpApiClient`. Change the contract first, then both sides; the compiler checks the rest.
- Imports come from stable entry points (`effect`, `effect/http`, `effect/http-api`, …), never `effect/unstable/*`.
  Effect 4.0 still marks `http-api` unstable; the exact pin is the stability boundary.
- Test with `it.effect` from `@effect/vitest` against fake layers, never module mocks.

`bun run typecheck` runs effect-tsrs with the severities in `tsconfig.base.json`; any error or warning fails. Fix the
finding, or suppress it on its line with an `@effect-diagnostics` comment that says why.
