# Tooling parity, 27 October 2026

Baseline: `a721d10`. [Machine-readable results](parity.json) include commands, all differences, project counts,
exit codes and resource measurements. Both linters used oxlint **1.89.0's Node launcher**, the complete root config,
and the nested web config with the **Foldkit JavaScript plugin**. No rule was disabled for the comparison.

| Backend | Files | Findings | Wall seconds | CPU seconds | Peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| oxlint-tsgolint 7.0.2004 | 310 | 0 | 10.197 | 30.408 | 1134.4 |
| tsrs-lint, pinned release | 310 | 0 | 7.211 | 16.574 | 802.8 |

These are single sequential samples on a shared Linux host, inside one `heavy` slot. CPU is child user plus system
time. Peak RSS is the `wait4` high-water reading, not a sum across simultaneous child processes.

The pin is [lint-pr624-0acc433-regions.1](https://github.com/grmkris/tsrs/releases/tag/lint-pr624-0acc433-regions.1).
Its Linux x64 SHA-256 is `17fef910b56c1638a9429e2c6e5f22dd89591234821687dc443d116be63832a5`.
`scripts/tsrs-lint.ts` owns the release URL and checksums. It verifies cached bytes on each use and installs fresh
bytes atomically only after checksum verification. Unsupported platforms, missing assets and checksum mismatches
fail the command. There is no stock backend dependency or fallback. The published macOS ARM64 binary is pinned;
this run verifies Linux only.

A temporary web source containing `Promise.resolve('unhandled')` and a literal `{ model: 1, commands: [] }` produced
the same two findings with both backends: `typescript/no-floating-promises` and `foldkit/no-empty-commands-array`.
Both exited 1. `bun run lint` also exited 1 with those findings. The source was removed after the check.

Six filesystem/HTTP tests cover verified installation, valid cache reuse, corrupt downloads, corrupt cached bytes,
missing assets and unsupported targets. Inverting the checksum guard made four tests fail; restoring it made the
suite pass. No live network is needed for these tests.

## effect-tsrs stays at 0.2.0

All nine configured projects were checked with **0.2.0** and **0.2.2 plus `--type-check`**, with `--strict` and JSON
output. Every invocation exited 0, and the TypeScript diagnostic arrays were identical. The full Effect diagnostic
sets were not identical:

| Project | 0.2.0 findings | 0.2.2 findings | Identical |
| --- | ---: | ---: | --- |
| Root scripts | 16 | 3 | No |
| API | 7 | 7 | Yes |
| Web | 8 | 8 | Yes |
| Worker | 56 | 55 | No |
| Infrastructure | 0 | 0 | Yes |
| Protocol | 1 | 1 | Yes |
| Stellar | 3 | 3 | Yes |
| Stellar tests | 7 | 7 | Yes |
| Seller | 0 | 0 | Yes |

All differences are advisory messages. Version 0.2.2 documents that imported files outside configured roots supply
types but receive no Effect diagnostics. The root run loses 13 messages from imported files; the Worker run loses
`schemaClassMissingBrand` at `apps/web/src/qr-decode.ts:4`. The exact records are in `parity.json`.

The requested upgrade requires identical diagnostics across all nine projects, so the pin and typecheck invocation
remain unchanged. A temporary `export const seededTypeError: string = 123` in `scripts/` caused the existing
`bun run typecheck` gate to exit 1 with TS2322. Any future 0.2.2 adoption must explicitly pass `--type-check`, preserve
this failure behavior and resolve or accept the diagnostic differences first. No `node_modules` patching was used.

## Editor and local acceptance

The [headless editor results](editors.json) exercise the actual configured commands on source-file overlays:

- `.vscode/tsrs/tsgo --lsp --stdio`: seeded TS2322 and hover, matching the VS Code/Cursor launcher.
- `node_modules/.bin/tsrs --lsp --stdio`: seeded TS2322 and hover, matching Zed's command.
- `node_modules/.bin/oxlint --lsp` with the verified backend environment: both the type-aware floating-promise rule
  and the Foldkit JavaScript plugin rule reject their seeded violations.
- Neovim 0.12.6 headless, with the documented snippet verbatim: `tsrs` and `oxlint` attached, TS2322,
  `no-floating-promises`, and hover all observed. No VS Code, Cursor or Zed GUI acceptance is claimed.

A seventh tooling test keeps the VS Code backend path synchronized with the release pin. Effect diagnostics still
come from `bun run typecheck`; the editor compiler is the separate pinned `tsrs` devDependency.

Local workerd acceptance used `bun run dev` and `HM_URL=http://localhost:18961 bun run smoke:local`:
[all nine HTTP checks passed](smoke-local.json), including OAuth protected-resource/authorization metadata, PKCE S256,
anonymous MCP rejection and the owner session gate. Port 18960 was occupied, so this run temporarily changed only
the local development port to 18961 in the owned worktree. That change was removed and the owned server stopped.
No port or infrastructure change is committed. This is local workerd evidence; no remote deployment was performed.

The full `heavy bun run check` passed for the lint adoption and editor source. It covers format, agent configuration,
generated cards and skill manifest, full lint, all nine typecheck projects, JavaScript tests (including OAuth/consent),
Rust formatting/clippy and 24 contract tests, plus the production web build. The existing build warning for a chunk
over 500 kB remains. Contract unit tests are not onchain execution evidence.

Delivery note: tooling only. No Worker behavior, binding, route, migration or contract change needs deployment.
Expected runtime metadata differences are none; a future authorized release naturally updates its commit metadata.
