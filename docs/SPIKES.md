# Spike results

The experiments ran during the 25 October 2026 build. Their individual reports preserve the commands, versions,
failures, transaction hashes, and limits of each result. Code and raw outputs remain under [`spikes/`](../spikes/).
The original schedules and agent assignments are in Git history.

## Results

| Spike | Question                                                               | Result and evidence                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0    | Can the foundation build and run?                                      | Foldkit, Effect, Worker, Alchemy, and the counter established the toolchain. Current validation is `heavy bun run check`.                                                 |
| S1    | Can a passkey-owned account enforce an AI's allowance?                 | [Seven claims passed](spikes/s1.md): exact limit, over-limit rejection, expiry, revoke, owner lane, and WebAuthn signing.                                                 |
| S2    | Can hosted x402 facilitators settle the payment?                       | [Passed after choosing a classic-account pocket](spikes/s2.md), over HTTP and MCP, through x402.org and OpenZeppelin Channels.                                            |
| S3    | Can a recipient create a trustline and receive USDC in one invocation? | [Passed](spikes/s3.md), with two narrow authorization entries. The wallet-signing adapter used a Freighter-shaped stub; real Freighter UI was not verified by this spike. |
| S4    | Can a remote OAuth MCP server run on Workers and connect to hosts?     | [Claims 1–4 and 6 passed; claim 5 was partial](spikes/s4.md). Claude Code connected live; other host coverage was limited at that point.                                  |
| S5    | Does the pocket model work end to end under the allowance?             | [Eight claims passed](spikes/s5.md), including idempotency, exhaustion, fees, revoke, and sweep.                                                                          |
| S6    | CCTP top-up                                                            | Deferred; no result is claimed. The later cross-chain integration uses [NEAR Intents](NEAR-INTENTS.md).                                                                   |
| S7    | Is mainnet viable?                                                     | [Read-only readiness study](research/mainnet.md), using RPC reads and unsigned simulations. Later execution is in the [mainnet record](MAINNET.md).                       |
| S8    | Can a classic deposit address fund a passkey wallet?                   | [Testnet deposit and signup results](spikes/s8-deposit.md), followed by a separate [mainnet deposit receipt](../evidence/mainnet/deposit-2026-10-25T21-46Z.md).           |

## How to use this evidence

A spike proves its own dated experiment. Fee estimates, rent multipliers, TTLs, provider capabilities, and outstanding
work in those reports describe the observation time. They are not current operational settings.

The [S4 connection guide](spikes/s4-connect.md) targets the isolated spike server. For Nod itself, use the
[product demo instructions](../README.md#demo-instructions) and [real-host screenshots](../evidence/mcp-apps/README.md).

The [judge test path](../evidence/JUDGE-TEST-PATH.md) links the product rehearsal. Acceptance test 3, a forced
onchain over-limit transfer, is referenced from S1 because the product routes that request to owner approval before
submission. Do not describe a product rehearsal as nine independently executed acceptance tests.

[Architecture decisions](BUILD-PLAN.md) and the [spec's decisions log](SPEC.md#decisions-log) explain how the
experiments shaped the build. [`research/`](research/) retains the earlier sources; the result reports identify where
those initial assumptions were corrected.
