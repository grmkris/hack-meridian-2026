# Automatic wallet event monitoring release

The owner requested automatic subscription to all Nod events when using Nod in a chat, then production promotion.
Both remote stages run application commit `ddf2d2d7ae8643845d7920637313afa42d562104`.

The served Nod skill, MCP instructions, and top-up tool guidance now ask the host to discover and subscribe to all
wallet events on first use in a chat, reuse existing subscriptions on subsequent turns, honor opt-outs and narrower
filters, refresh subscriptions, and report notifications only after the host confirms setup. Top-ups reuse wallet
monitoring; terminal cleanup removes only subscriptions created specifically for that top-up. Event notifications
do not authorize new payments. ChatGPT still controls subscription creation and any required confirmation.

## Verification

- `heavy bun run check` exited 0 in both the main checkout and the clean authoritative deployment checkout
  `/srv/cache/hm26/deploy-testnet`, pinned to the application commit. Formatting, skills/card drift, lint, all
  TypeScript projects, 376 tests in 68 files (16 live tests skipped), clippy, 24 Rust tests and build passed.
  The existing Vite advisory about a client chunk larger than 500 kB remains.
- `bun install --frozen-lockfile` exited 0 in the deployment checkout. The skill validator reported "Skill is valid!"
  and the regenerated manifest matches all four skill files.
- The inspected plans changed only the Worker and RELEASE binding. Both deploy commands exited 0; Durable Object
  deleted, renamed, transferred and new class lists are empty. No migration, contract deployment or payment ran.
- Testnet deployment completed at 04:19 UTC. HTTP smoke: 9/9, exit 0.
- Production deployment completed at 04:21 UTC. HTTP smoke: 8/9, exit 1 solely for the testnet-only counter returning
  `404 NotDeployed` on mainnet, the documented exception in `docs/DEPLOY.md`.
- Live health reports the exact application commit, expected network, enabled payments and open signup on both
  stages. Every served skill file matches its build manifest digest and size, including the automatic monitoring
  instructions. See `live-readback.json`.
- Authenticated MCP 2.0 (`2026-07-28`) `server/discover`, `events/list` and `skills/list` each returned HTTP 200 on
  testnet. Discovery includes `capabilities.events` and the new instructions. All ten advertised events accept
  empty filter arguments. See `modern-testnet.json`. An initial probe using the legacy helper's version header
  was correctly refused as a header/body mismatch; the protocol-correct probe passed.

## Demo use and evidence boundary

Refresh/rescan Nod in ChatGPT to load the instructions, then use Nod in a Work chat (Cloud on desktop). Check that
ChatGPT acknowledges event monitoring. The skill asks for automatic setup; it cannot create a ChatGPT callback or
force the host to subscribe. Existing chats may retain cached instructions, so a fresh chat is useful for the demo.

This release proves deployed instructions, authenticated event discovery and public HTTP behavior. It does not prove
that ChatGPT automatically creates all ten subscriptions from an ordinary prompt, or that a funded cross-chain
top-up wakes the chat; those require the live ChatGPT demo. No funded top-up or payment was submitted in this release.
NEAR Intents top-ups require the production/mainnet endpoint.

Official host behavior: <https://developers.openai.com/plugins/build/mcp-events>.

- Production MCP: <https://trynod.si/mcp>
- Testnet MCP: <https://testnet.trynod.si/mcp>

This evidence commit changes no application code; `/api/health` is the source for the running release.
