# contracts

The Soroban workspace. Follow the root [AGENTS.md](../AGENTS.md); read the `stellar-smart-contracts` skill (and its
`security.md` and `testing.md`) before changing a contract.

- `soroban-sdk` 29.0.1 for protocol 29 (testnet and mainnet as of 2026-10-25), built and deployed with stellar-cli
  28.1.0 (`stellar contract build` targets `wasm32v1-none`).
- OpenZeppelin's crates (`stellar-accounts`, `stellar-tokens`, … 0.8.0) need `soroban-sdk ^28`, and SDK 28 and 29
  cannot share this workspace (a `soroban-wasmi` links conflict). The smart-account contracts are used as already
  deployed on testnet instead; see `docs/research/smart-accounts.md`. A custom OpenZeppelin build would need its own
  workspace on SDK 28.
- One crate per contract under `contracts/<name>`, added to `members` in `Cargo.toml`. Unit tests live in
  `src/test.rs` with `soroban_sdk::testutils`; `test_snapshots/` is generated and ignored.
- Every state change is authorized (`require_auth` on the account that pays or owns), every storage write extends its
  TTL, failures are a `#[contracterror]` enum, and changes worth indexing publish a `#[contractevent]`.
- Crates: `counter` (the baseline example, with bindings in `packages/counter-client`), `deposit` (the deposit router:
  `register(g, c)` binds a classic deposit address to a wallet and approves the router, `sweep(g)` moves its USDC to
  that wallet for anyone who calls it; no admin, no upgrade; `docs/spikes/s8-deposit.md`) and `onboard`, the CAP-73
  trust-and-pay router the Worker calls. `onboard` keeps no storage and delegates auth and errors to the SAC, so the
  rules above hold through the SAC. It was deployed from `spikes/s3` and is recorded by hand in
  `deployments/testnet.json`; any change to its source changes its wasm hash, so it needs a fresh deploy, a new record
  and the new id in `packages/stellar`. Check with `stellar contract build --package onboard` and compare the hash.
- `bun run contracts:lint` (fmt + clippy `-D warnings`) and `bun run contracts:test` gate every change.
- Deploy with `bun run contracts:deploy` (testnet only, identity `hm-deployer`); it records the id and wasm hash in
  `deployments/testnet.json`, which the Worker reads at deploy time. Then `bun run contracts:bindings` regenerates
  `packages/counter-client`. Commit the record and the bindings together with the contract change.
- The deployer's secret stays in `~/.config/stellar/identity/`; never read it into a file, log or commit.
