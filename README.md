# Nod

**Small stuff, it just pays. Big stuff needs your nod.**

Nod is a Stellar wallet you add to Claude, or any MCP app. You give each AI app an allowance, say 5 USDC until tomorrow,
and it pays for APIs and pays your contacts on its own, inside that allowance. Anything bigger comes back to you as a
link, and one passkey tap approves that exact recipient and amount. The allowance is an OpenZeppelin spending-limit
policy on your Stellar account, not a setting on our server: the most our service could ever spend for an AI app is what
you allowed it.

Built at [HackMeridian 2026](https://www.hackmeridian.com/) (Lisbon, 25–26 October 2026): Genesis builder track,
**Stellar Composed** thematic track. **Live on Stellar testnet:** [hack-meridian-testnet.kristjan-grm11775.workers.dev](https://hack-meridian-testnet.kristjan-grm11775.workers.dev) · Claude
connector `https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp`. Product spec: [docs/SPEC.md](docs/SPEC.md).

## Problem

People who use AI assistants want them to finish tasks that cost money: buy a paid API result, pay a friend back, cover
a small bill. Today they hand the assistant a card or a private key, which gives it everything, or they make every
payment themselves, which defeats the point. Sellers of paid APIs feel it too: x402 lets agents pay per call, but
Stellar's docs note that "there is no policy layer for x402 on Stellar today", so few owners let an agent hold money.
Nod gives each AI app its own allowance on the owner's account, enforced onchain, with one passkey tap for the
exceptions.

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

## Demo instructions

Everything below runs on Stellar testnet with testnet USDC. You need Claude (claude.ai, Claude Desktop or Claude Code)
and a device that can create a passkey. New wallets receive 10 testnet USDC.

1. **Connect.** In claude.ai: Settings → Connectors → Add custom connector, name `Nod`, URL `https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp`, leave the
   OAuth client fields empty, then Connect. In Claude Code: `claude mcp add --transport http -s user nod https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp`,
   then `/mcp` → nod → Authenticate.
2. **Create your wallet and allowance.** The consent page opens: create a passkey wallet, read "Allow Claude to spend up
   to 5 USDC … until tomorrow", and approve with your passkey.
3. **Ask Claude:** "Show my Nod wallet overview" · "Buy the market brief at
   https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief" (0.10 USDC, no prompt) · "Send Alice 2 USDC"
   (2.90 left) · "Pay Bob 5 USDC for dinner" (more than what is left, so Claude returns a link; open it and approve with
   your passkey) · "Send Carol 1 USDC" (Carol has no USDC trustline: a claim link she signs; trustline and payment land
   in one transaction).
4. **Revoke** Claude on the site under Connections; its next payment is refused.

Expected results for every step, with reference transactions: [evidence/JUDGE-TEST-PATH.md](evidence/JUDGE-TEST-PATH.md).

## Proof on testnet

From the product (the wallet service against Stellar testnet):

| What happened                                                       | Transaction                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A passkey wallet created through the product                        | [`CAKADCRB…SDIS`](https://stellar.expert/explorer/testnet/contract/CAKADCRBDPEYNNFVNQUWIMPUY53XP7DJUO6DXNNJAHJDIK5EWFSDSDIS) |
| x402 purchase: Claude's key fills its pocket under the policy…      | [`646d95c9`](https://stellar.expert/explorer/testnet/tx/646d95c918bc43e1ea22f8ffc6efd48b197344d3add94599b2e40c1248a62945)    |
| …and x402.org settles the 0.10 USDC to the seller                   | [`1c680612`](https://stellar.expert/explorer/testnet/tx/1c6806128d7020f4fe4aa4906c8d0158cc403dd3e1c38ba9988f649442138a19)    |
| 20 USDC dinner approved with the passkey                            | [`8f9e79cb`](https://stellar.expert/explorer/testnet/tx/8f9e79cb0df7f06dd7b813988a5b6d71ad5afb32ed57e306c108303b74d44a9f)    |
| Carol's trustline and 5 USDC in one transaction (CAP-73 claim link) | [`8457e9cb`](https://stellar.expert/explorer/testnet/tx/8457e9cb67895e86155535a37b64308a60bfb3112c6050b60049537860536bf1)    |

From the spikes that proved each risky part first (full record with commands in [docs/spikes/](docs/spikes/)):

| Claim                                                                          | Transaction                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| An app key under a 5 USDC allowance spends exactly 5.0 (one stroop more fails) | [`c0f6f923`](https://stellar.expert/explorer/testnet/tx/c0f6f923936b7dc4d716454ba3e3d3f43f21ddcf353e49e3e083d054bf5f9c57) |
| An over-allowance transfer forced onchain is rejected by the account (`#3221`) | [`3daf4b00`](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a) |
| A passkey-only account pays with a WebAuthn signature                          | [`4b135c1c`](https://stellar.expert/explorer/testnet/tx/4b135c1cba6872a7cdf1ff6e314674e92635243c7f5e4cdc496ed41144888ee1) |
| A passkey installs an app's allowance                                          | [`f3160c7e`](https://stellar.expert/explorer/testnet/tx/f3160c7e183e52c4a633804d60d50a956c627e88bc461be2f8f5fad7b14bb110) |
| A paid MCP tool, settled through OpenZeppelin Channels                         | [`4ddef672`](https://stellar.expert/explorer/testnet/tx/4ddef672157938a4af086bffbf67b66a1e37c8bf7ec8352300019c0398b65671) |
| Revoke sweeps the pocket back to the wallet                                    | [`b233c0cc`](https://stellar.expert/explorer/testnet/tx/b233c0ccb8ee244602b8fa891c6415062de9be4f2816a23ec87fb5302b4820dd) |

## Architecture

```
Claude (or any MCP app)
   │  MCP over OAuth 2.1 (PKCE; CIMD or dynamic registration)
   ▼
Nod Worker on Cloudflare      /mcp · /authorize · /approve/:id · /claim/:id · /api · static site
   ├─ D1: wallets, allowances, contacts, payments, receipts
   ├─ Durable Object per wallet: reservations, idempotency, one submit at a time
   ├─ signer boundary: relayer key, per-app keys encrypted with AES-GCM
   └─ x402 client ──▶ x402.org or OpenZeppelin Channels (public facilitators)
   │  Soroban RPC
   ▼
Stellar testnet
   ├─ your smart account (OpenZeppelin): rule 0 = your passkey; one rule per AI app = its key + spending limit + expiry
   ├─ USDC through the Stellar Asset Contract
   ├─ one small pocket account per AI app (sponsored reserves) for x402
   └─ trust-and-pay router (CAP-73) for claim links
Browser (Foldkit site): passkey sign-in, Home, Connections, Contacts, Receipts, approval and claim pages
```

**A payment inside the allowance:** the Durable Object reserves the amount → the Worker builds a USDC `transfer` from
your account → simulates it → the app's key signs its auth entry → re-simulates in enforcing mode (over-limit fails
here, before anything reaches the chain) → the relayer signs and submits → a receipt is returned after confirmation.
**A payment that needs your nod:** the intent is frozen → the approval page shows recipient name and address, amount,
fee ceiling and which app asked → your passkey signs a WebAuthn challenge bound to that exact auth payload → submitted
by the relayer; the allowance is untouched. **x402:** request → HTTP 402 → validate network, asset, price, payee →
pull the shortfall (at least 1 USDC) into the pocket under the policy → the stock `@x402/stellar` client pays → retry →
content and both hashes on the receipt.

How Stellar is used:

| Stellar piece                                | Role in Nod                                                  | Testnet id                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenZeppelin smart account (Soroban)         | one contract account per wallet, deployed by the relayer     | WASM `1b5f4534…785a`                                                                                                                                                                                                                                      |
| OpenZeppelin spending-limit policy           | the allowance: N USDC until T, per AI app                    | [`CABXBYJN…IP5G`](https://stellar.expert/explorer/testnet/contract/CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G)                                                                                                                              |
| WebAuthn verifier (secp256r1 host function)  | your passkey: admin, approvals, allowance changes            | [`CC7EKIHQ…OM3F`](https://stellar.expert/explorer/testnet/contract/CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F)                                                                                                                              |
| Ed25519 verifier                             | each AI app's own key                                        | [`CAAVTMCB…HKN4`](https://stellar.expert/explorer/testnet/contract/CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4)                                                                                                                              |
| Circle USDC, Stellar Asset Contract (SEP-41) | the money (7 decimals)                                       | [`CBIELTK6…DAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA)                                                                                                                              |
| SAC `trust` (CAP-73) + our router            | claim link: trustline and transfer in one invocation         | [`CCLFB4I4…PGN4`](https://stellar.expert/explorer/testnet/contract/CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4)                                                                                                                              |
| Soroban authorization                        | per-signer auth entries, enforcing re-simulation             |                                                                                                                                                                                                                                                           |
| Sponsored reserves                           | pocket accounts hold 0 XLM                                   |                                                                                                                                                                                                                                                           |
| Relayer pool as transaction source           | Nod pays every fee; owners hold no XLM                       | [`GBCALSA3…YWBR`](https://stellar.expert/explorer/testnet/account/GBCALSA3XQAWW24AXGFWJIGNUCDBCMUPPWC5XHMZ22VY4HMX6XCFYWBR), [`GAWYWVMH…YSE4I`](https://stellar.expert/explorer/testnet/account/GAWYWVMHLTRN6N7DXKV3XYCLAFPCPPUXPDFC7J5KL3LNKO26YNJSYE4I) |
| x402 on `stellar:testnet`                    | paid APIs through x402.org and OpenZeppelin Channels         |                                                                                                                                                                                                                                                           |
| Built-in DEX                                 | the demo seller's market brief reads the XLM/USDC order book |                                                                                                                                                                                                                                                           |

The router is our one contract. `stellar contract build` in `contracts/` reproduces the deployed WASM byte for byte
(sha256 `39c97734…`, 920 bytes), so [`CCLFB4I4…PGN4`](https://stellar.expert/explorer/testnet/contract/CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4) is provably this source
([deploy transaction](https://stellar.expert/explorer/testnet/tx/634bcf1894f1c82e76f1674791f8449341db2fade872f680c904e729beaf3626); record in
[`contracts/deployments/testnet.json`](contracts/deployments/testnet.json)).

Deployed:

| What                         | Where                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| Site and wallet service      | https://hack-meridian-testnet.kristjan-grm11775.workers.dev          |
| MCP connector                | `https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp`    |
| Demo x402 seller (0.10 USDC) | https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief   |
| Machine-readable summary     | https://hack-meridian-testnet.kristjan-grm11775.workers.dev/llms.txt |

Software: one TypeScript program from the browser to the edge. **[Foldkit](https://foldkit.dev)** (Elm architecture on
Effect) for the site; **[Effect](https://effect.website) 4** for the Worker, with an `HttpApi` contract in
`packages/api` shared by browser and Worker; **[Alchemy](https://alchemy.run)** declares the Worker, D1 and Durable
Objects in `apps/web/alchemy.run.ts` (stages `local` and `testnet`); `packages/stellar` talks to Stellar through
`@stellar/stellar-sdk` 16.4.1; the trust-and-pay router is Rust on soroban-sdk 29 in [`contracts/onboard`](contracts/onboard).

## Setup and installation

Requirements: Bun 1.4.2, Node 24, Rust with the `wasm32v1-none` target, and
[stellar-cli](https://github.com/stellar/stellar-cli) 28.1.

```sh
bun install
bun run dev            # http://localhost:18960: the app and its API under local workerd, reading testnet
bun run smoke:local    # HTTP acceptance of the running stage
bun run shots          # phone and desktop screenshots in .local/shots/
bun run check          # format, lint, typecheck (TypeScript + Effect diagnostics), tests, contract tests, build
```

Without any secrets the Worker runs on an in-memory fixture chain (`CHAIN=fixture`, the default). To use the real chain,
set `CHAIN=stellar` and the secrets below in `apps/web/.env.<stage>`; `scripts/stage.ts` binds them as Worker secrets.
`bun run deploy:testnet` deploys the `testnet` stage.

Contracts:

```sh
bun run contracts:test       # unit tests (soroban testutils)
bun run contracts:deploy     # build and deploy to testnet; records the id in contracts/deployments/testnet.json
bun run contracts:bindings   # regenerate packages/counter-client from the wasm
```

## Environment variables

Secrets are bound as Worker secrets and never committed. Everything else is plain and has a default.

| Name                                                                                                                  | Default               | Meaning                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `CHAIN`                                                                                                               | `fixture`             | `fixture` = in-memory chain; `stellar` = the real chain on `STELLAR_NETWORK` |
| `STELLAR_NETWORK`                                                                                                     | `testnet`             | `testnet` or `pubnet` preset (contract ids, RPC, passphrase)                 |
| `ORIGIN`                                                                                                              | request origin        | public URL for the OAuth issuer, links and the passkey origin                |
| `RP_ID`                                                                                                               | request host          | passkey relying-party id                                                     |
| `RELAYER_SECRET` or `RELAYER_SECRETS` (secret)                                                                        | none                  | fee-paying source account(s); required on the real chain                     |
| `VAULT_KEY` (secret)                                                                                                  | none                  | AES-GCM key that encrypts each AI app's key; required                        |
| `TREASURY_SECRET` (secret)                                                                                            | none                  | funds new testnet wallets with welcome USDC                                  |
| `OZ_FACILITATOR_KEY` / `OZ_CHANNELS_API_KEY` (secret)                                                                 | none                  | OpenZeppelin Channels, the fallback x402 facilitator                         |
| `DEMO_RECIPIENT_SECRET` (secret)                                                                                      | none                  | signs as Carol in the demo claim link                                        |
| `INVITE_CODES` (secret)                                                                                               | empty                 | required to create a wallet on pubnet; empty = closed                        |
| `WELCOME_USDC_STROOPS`                                                                                                | `100000000` (10 USDC) | welcome USDC for a new wallet, testnet only                                  |
| `MAX_GRANT_USDC` · `MAX_OWNER_PAYMENT_USDC` · `MAX_X402_PRICE_USDC`                                                   | `20` · `100` · `1`    | largest allowance, largest single payment, largest x402 price                |
| `PAYMENTS_ENABLED`                                                                                                    | `true`                | kill switch; revoke and sweep still work                                     |
| `MAX_FEE_STROOPS` · `FIRST_PULL_MAX_FEE_STROOPS` · `PULL_MAX_FEE_STROOPS`                                             | testnet ceilings      | fee ceilings, sized for testnet rent                                         |
| `X402_FACILITATOR_URL` · `X402_FALLBACK_FACILITATOR_URL`                                                              | x402.org              | facilitators                                                                 |
| `OWNER_AUTH_LEDGERS` · `WALLET_TTL_LEDGERS`                                                                           | `400` · `518400`      | approval validity and wallet state lifetime, in ledgers                      |
| `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, contract id overrides (`USDC_SAC_ID`, `SPENDING_LIMIT_POLICY_ID`, …) | the preset            | overrides for another network                                                |

Bindings (not variables): `WALLET_DB` (D1), `WALLET_OBJECT` and `OAUTH_STORE` (Durable Objects), `ASSETS`.

## Repository

| Path                | What                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web`          | Foldkit site, Cloudflare Worker (OAuth, MCP tools, pages) and the Alchemy stack                 |
| `apps/seller`       | the demo x402 seller Worker (HTTP and a paid MCP tool)                                          |
| `packages/stellar`  | the Stellar chain package: accounts, allowances, payments, pocket, x402, claim                  |
| `packages/protocol` | tool and entity schemas shared by the service and the chain package                             |
| `packages/api`      | the HTTP API contract (Effect Schema) shared by browser and Worker                              |
| `contracts`         | Soroban workspace: the trust-and-pay router (`onboard`), a toolchain counter, deployment record |
| `scripts`           | stage runner, smoke and screenshot checks, rehearsal runner                                     |
| `docs`, `spikes`    | product spec, research and the spikes that de-risked it                                         |
| `evidence`          | rehearsal runs, settlements and the judge test path                                             |

## Prior work

Everything in this repository was written during HackMeridian; the commit history starts on 25 October 2026. Used as-is
from others: OpenZeppelin's deployed Stellar smart-account, verifier and spending-limit contracts; Circle's testnet
USDC; the x402 libraries and the hosted facilitators x402.org and OpenZeppelin Channels; agent skills vendored with
source, commit and licence in `.agents/skills/sources.json`. Repository conventions and agent tooling come from
Kristjan's earlier projects.

## Built with AI

Nod was written by Kristjan with Claude Code (Claude Opus 5.5): parallel sessions for the spec, the spikes and the build
streams, working on one shared `main` under the rules in [AGENTS.md](AGENTS.md). Raven, Stellar's MCP server, and
Stellar's developer skills supplied documentation and ecosystem research. Every onchain claim above was run on testnet,
not generated.

MIT licensed.
