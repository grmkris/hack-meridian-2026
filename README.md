# HackMeridian 2026

A Stellar project built at [HackMeridian 2026](https://www.hackmeridian.com/) (Lisbon, 25–26 October 2026). What it
does and why is in [docs/SPEC.md](docs/SPEC.md); this page covers how it is built and how to run it.

## Stack

One TypeScript program from the browser to the edge, and Soroban contracts on Stellar testnet:

- **[Foldkit](https://foldkit.dev)** (Elm architecture on Effect) for the browser app, `apps/web/src/main.ts`.
- **[Effect](https://effect.website) 4** for the Worker: an `HttpApi` contract in `packages/api` that the Worker
  implements and the browser calls through a typed client, services as Layers, settings through `Config`.
- **[Alchemy](https://alchemy.run)** declares the Cloudflare Worker (app assets plus `/api`) in
  `apps/web/alchemy.run.ts`, with a local stage under workerd and a `testnet` stage on workers.dev.
- **Soroban** contracts in `contracts/` (Rust, soroban-sdk 29, protocol 29), with generated TypeScript bindings the
  Worker uses to talk to Stellar RPC.

```
browser (Foldkit) ──HttpApiClient──▶ Worker /api (Effect HttpApi) ──bindings + Stellar RPC──▶ Soroban contract
```

## Run it

Requirements: Bun 1.4.2, Node 24, Rust with the `wasm32v1-none` target, and
[stellar-cli](https://github.com/stellar/stellar-cli) 28.1.

```sh
bun install
bun run dev            # http://localhost:18960: the app and its API under local workerd, reading testnet
bun run smoke:local    # HTTP acceptance of the running stage
bun run shots          # phone and desktop screenshots in .local/shots/
bun run check          # format, lint, typecheck (TypeScript + Effect diagnostics), tests, contract tests, build
```

Contracts:

```sh
bun run contracts:test       # unit tests (soroban testutils)
bun run contracts:deploy     # build and deploy to testnet; records the id in contracts/deployments/testnet.json
bun run contracts:bindings   # regenerate packages/counter-client from the wasm
```

## Deployed

| What             | Where                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Counter contract | [`CAKTREEY…GUC4ON2`](https://stellar.expert/explorer/testnet/contract/CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2) (testnet) |

## Repository

| Path                | What                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `apps/web`          | Foldkit app, Cloudflare Worker and the Alchemy stack                   |
| `packages/api`      | the HTTP API contract (Effect Schema) shared by browser and Worker     |
| `packages/*-client` | generated contract bindings                                            |
| `contracts`         | Soroban contracts and the record of their testnet deployments          |
| `scripts`           | stage runner, smoke and screenshot checks, typecheck, contract tooling |
| `docs`, `spikes`    | product spec, research and the experiments that de-risked it           |

Coding agents start at [AGENTS.md](AGENTS.md). MIT licensed.
