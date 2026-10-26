# QR recipient release promotion

On 26 October 2026, the owner requested production promotion after testnet verification. Both remote stages now
run application commit `f46b694630669bc3838fb1aa6da3979a1da2ac3b`, which adds the `recipient_read` attachment/text
tool and the `recipient_scan` MCP Apps camera/upload card. This receipt supersedes earlier release readbacks;
`/api/health` remains the source for the running release.

The authoritative deployment checkout `/srv/cache/hm26/deploy-testnet` was clean and pinned to that commit.
`bun install --frozen-lockfile` and `heavy bun run check` exited 0 there: formatting, generated artifacts, lint,
typecheck, 68 TypeScript test files / 376 tests (16 live tests skipped), 24 Rust tests, clippy, and build passed.
The build retains its existing advisory about a client chunk larger than 500 kB.

The inspected plans changed only the Worker and RELEASE binding. Database, secrets, identity settings, and
Durable Object bindings were unchanged. Both deployments exited 0; the deployment logs record empty deleted,
renamed, transferred, and new Durable Object class lists. No contract deployment or payment was submitted.

- Testnet: `https://testnet.trynod.si/mcp`; deployed at 03:13 UTC; smoke 9/9, exit 0.
- Production: `https://trynod.si/mcp`; deployed at 03:14 UTC; smoke 8/9, exit 1 solely because the testnet-only
  counter returns `404 NotDeployed` on mainnet, as documented in `docs/DEPLOY.md`.
- Phone and desktop Chromium screenshots passed on both stages, with no page errors or horizontal overflow.
  Screenshots remain in the deployment checkout's `.local/shots/`.
- `live-readback.json` records the exact release, network, enabled payments, open signup, and identical SHA256
  of served JavaScript on both stages. The served tool guide matches the build and includes both scanner tools.
- The main checkout's later `f654595` commit adds only landing deployment evidence; application code is identical
  to the deployed release. This receipt also changes no application code.

The separate read-only `scripts/mainnet/check-env.ts` confirms valid credentials and bootable pubnet bindings,
but exits 1 because it still expects the old 20/50/1 USDC caps. The unchanged 1,000,000 USDC caps were authorized
and documented in `docs/SPEC.md` and `evidence/deployments/2026-10-25.md`. The Alchemy plans confirm these bindings
are no-ops. No environment setting was changed for this promotion.

This promotion verifies deployment, public HTTP/OAuth behavior, and signed-out browser rendering. Authenticated
scanner use in a live chat, physical camera access in that host, and a live payment were not exercised in this
promotion. The earlier implementation's local browser checks cover image decode, address review, confirmation,
camera-denied upload recovery, synthetic camera capture, and track cleanup.
