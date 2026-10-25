# Nod

**Small stuff, it just pays. Big stuff needs your nod.**

Nod is a Stellar wallet you add to Claude, or any MCP app. You give each AI app an allowance, say 5 USDC until tomorrow,
and it pays for APIs and pays your contacts on its own, inside that allowance. Anything bigger comes back to you as a
link, and one passkey tap approves that exact recipient and amount. The allowance is an OpenZeppelin spending-limit
policy on your Stellar account, not a setting on our server: the most our service could ever spend for an AI app is what
you allowed it.

Built at [HackMeridian 2026](https://www.hackmeridian.com/) (Lisbon, 25–26 October 2026) in the **Stellar Composed**
track. Testnet only. Product spec: [docs/SPEC.md](docs/SPEC.md).

## How it works

| You want…                        | Who signs                               | What enforces it                                                  |
| -------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Claude to buy a 0.10 USDC report | Claude's own key, inside its allowance  | the account's context rule and spending-limit policy, with expiry |
| Claude to send Alice 2 USDC      | Claude's own key, inside its allowance  | the same rule; the same allowance counts both                     |
| Claude to send Bob 20 USDC       | **you**, with your passkey, from a link | the account checks the passkey signature over that exact payment  |
| to stop Claude                   | you, on the site                        | the service stops at once; the rule is removed from the account   |

- **One allowance per AI app.** Connecting an app over OAuth and approving its allowance with your passkey is one step;
  the allowance is a rule on your account, separate for each app, expiring, revocable.
- **Too big? It asks you.** A payment above what is left is never signed with the app's key. It becomes a link that
  shows the recipient's name and address, the amount and which app asked; your passkey signs exactly that.
- **Paid APIs through the open standard.** x402 sellers are paid through public facilitators (x402.org, OpenZeppelin
  Channels). Hosted facilitators do not accept smart-account payers yet, so the app's key also owns a small account (the
  pocket) that it fills from your wallet under the same policy, then pays from. Ask twice, pay once.
- **Pays people who have never held USDC.** A contact without a USDC trustline gets a claim link: they sign once, and the
  trustline (through the USDC contract's `trust` function, CAP-73) and the payment land in one transaction.
- **No seed phrase, no gas.** A passkey owns the account and you never need XLM: Nod pays the network fees.

## Proof on testnet

Each line links to the transaction on stellar.expert. The full record, with the commands, is in `docs/spikes/`.

| Claim                                                                          | Transaction                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| An app key under a 5 USDC allowance spends exactly 5.0 (one stroop more fails) | [`c0f6f923`](https://stellar.expert/explorer/testnet/tx/c0f6f923936b7dc4d716454ba3e3d3f43f21ddcf353e49e3e083d054bf5f9c57) |
| An over-allowance transfer forced onchain is rejected by the account (`#3221`) | [`3daf4b00`](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a) |
| A passkey-only account pays with a WebAuthn signature                          | [`4b135c1c`](https://stellar.expert/explorer/testnet/tx/4b135c1cba6872a7cdf1ff6e314674e92635243c7f5e4cdc496ed41144888ee1) |
| A passkey installs an app's allowance                                          | [`f3160c7e`](https://stellar.expert/explorer/testnet/tx/f3160c7e183e52c4a633804d60d50a956c627e88bc461be2f8f5fad7b14bb110) |
| The app key fills its pocket under the policy…                                 | [`594e5b6a`](https://stellar.expert/explorer/testnet/tx/594e5b6a722a995ee65c42d30807195f808a73b171c7c61234f7720251925a9d) |
| …and pays an x402 seller through x402.org                                      | [`f2d4b987`](https://stellar.expert/explorer/testnet/tx/f2d4b987428d4b2a8390e4fd3d54d19c9da4f1bbed54e1d1312ad93894e7c784) |
| A paid MCP tool, settled through OpenZeppelin Channels                         | [`4ddef672`](https://stellar.expert/explorer/testnet/tx/4ddef672157938a4af086bffbf67b66a1e37c8bf7ec8352300019c0398b65671) |
| Revoke sweeps the pocket back to the wallet                                    | [`b233c0cc`](https://stellar.expert/explorer/testnet/tx/b233c0ccb8ee244602b8fa891c6415062de9be4f2816a23ec87fb5302b4820dd) |
| Trustline and payment to a new USDC holder in one transaction                  | [`d931ec26`](https://stellar.expert/explorer/testnet/tx/d931ec2674e48d0f4edb21072937edbc7a21bf7d86cd735005d3c8b599fa4f8e) |

## Try it

The judge test path (deployed URL, the connector URL to add to Claude, a passkey wallet funded with 10 testnet USDC,
and the steps with expected results) is in [evidence/JUDGE-TEST-PATH.md](evidence/JUDGE-TEST-PATH.md).

## Built with AI

Nod was written by Kristjan with Claude Code (Claude Opus 5.5): parallel sessions for the spec, the spikes and the build
streams, working on one shared `main` under the rules in [AGENTS.md](AGENTS.md). Every onchain claim above was run on
testnet, not generated.

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
