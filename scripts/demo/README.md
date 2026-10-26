# Demo accounts and scripts

The commands below are for Stellar testnet. The shared helpers also support `--network pubnet` with separate
`seeds.pubnet.json` and `.env.pubnet`; submissions on pubnet require the owner's explicit go and the
`HM26_MAINNET_GO` guard. `--target` chooses a service URL; it does not choose the transaction network.

Testnet secret keys live in `scripts/demo/.env` (gitignored, mode 600); public ids are in
[`seeds.json`](seeds.json). No script prints a secret.

| Command                                                      | What it does                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `bun scripts/demo/seed.ts`                                   | creates or tops up every account below (idempotent), writes `seeds.json`, prints the table                           |
| `bun scripts/demo/seed.ts --table`                           | the table only (public keys and balances)                                                                            |
| `bun scripts/demo/topup.ts --target testnet <C…\|G…> <usdc>` | treasury → any wallet (USDC SAC transfer); prints the tx hash and explorer link. Use the amount required for the run |
| `bun scripts/demo/pay.ts [--mcp]`                            | pays the demo seller once from `BUYER` with the stock x402 client, repeats the id (dedup)                            |
| `bun scripts/demo/ttl.ts [--extend]`                         | TTLs of the shared contracts (policy, verifiers, account WASM, router); extends short ones                           |
| `bun scripts/demo/oz-key.ts`                                 | OpenZeppelin Channels testnet key → `apps/seller/.dev.vars` (`OZ_FACILITATOR_KEY`)                                   |
| `bun scripts/demo/rehearse.ts`, `probe.ts`                   | the nine-step rehearsal and the demo-day health probe (see their headers)                                            |

## Accounts

Amounts below describe the original testnet seed targets, not current balances. Read the probe before a rehearsal.

| Role (`.env` name)           | Kind                    | Holds                                     | Used by                                                      |
| ---------------------------- | ----------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `RELAYER_SECRET`             | classic G               | ~10,000 XLM (friendbot), no trustline     | the service: source and fee payer of every smart-account tx  |
| `TREASURY_SECRET`            | classic G + trustline   | 300 USDC (bought on the testnet DEX), XLM | the service: auto-funds each new wallet with 10 USDC         |
| `SELLER_SECRET`              | classic G + trustline   | what buyers paid                          | `apps/seller` `PAY_TO` (only the public key is needed there) |
| `BUYER_SECRET`               | classic G + trustline   | ~2 USDC                                   | `pay.ts`, `probe.ts`: pays the seller directly               |
| `ALICE_OWNER_SECRET`         | Ed25519 key, unfunded   | nothing                                   | rule-0 owner of Alice's smart account                        |
| `ALICE_CONTRACT_ID` (public) | OZ smart account C…     | receives USDC                             | contact **Alice** (`C…`, ready if the contract exists)       |
| `BOB_SECRET`                 | classic G + trustline   | 1.5+ XLM                                  | contact **Bob** (`usdc_ready`)                               |
| `CAROL_SECRET`               | classic G, no trustline | 1.5+ XLM                                  | contact **Carol** (`trustline_required` → claim link)        |
| `OPS_SECRET`                 | classic G               | XLM                                       | pays shared-contract TTL extensions (`ttl.ts`)               |

Alice was deployed from the account WASM `1b5f4534…` exactly as `spikes/s1/src/signer.ts` `deployAccount` does:
`createCustomContract` with constructor `(vec[External(ED25519_VERIFIER, owner_pubkey)], map{})`, relayer as source.

## Service configuration and funding

The stack reads keys from the stage's gitignored `apps/web/.env.<stage>` and binds them as Worker secrets. The chain
package receives them as redacted configuration. Use the authoritative deployment checkout and procedure in
[DEPLOY.md](../../docs/DEPLOY.md); do not deploy from this shared source checkout.

- **Relayer**: the testnet probe flags balances below 500 XLM. Top up with `bun scripts/demo/seed.ts --only RELAYER` (merges a fresh friendbot account in
  when under 500 XLM).
- **Treasury**: 10 USDC per new wallet, so 300 USDC covers ~25 wallets plus rehearsals. Rebuy with
  `bun scripts/demo/seed.ts --only TREASURY --treasury 300` (a path payment on the testnet DEX; cost varies).
- The public addresses the service needs for contacts are in `seeds.json → contacts` (Alice `C…`, Bob `G…`, Carol `G…`).
  Testnet seeds them for new wallets by default; `SEED_DEMO_CONTACTS` controls the stage behavior.
- Carol stops being `trustline_required` once a claim lands. To reuse her, send her USDC back to the treasury and remove
  the trustline (the rehearsal does this at the end), or create a fresh Carol: delete `CAROL_SECRET` and rerun the seed.
