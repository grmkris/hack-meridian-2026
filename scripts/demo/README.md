# Demo accounts and scripts (stream C)

Everything here runs on **Stellar testnet** only. Secret keys live in `scripts/demo/.env` (gitignored, mode 600), one
`<ROLE>_SECRET=S…` line per account; public ids are in [`seeds.json`](seeds.json). No script prints a secret.

| Command                                    | What it does                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `bun scripts/demo/seed.ts`                 | creates or tops up every account below (idempotent), writes `seeds.json`, prints the table |
| `bun scripts/demo/seed.ts --table`         | the table only (public keys and balances)                                                  |
| `bun scripts/demo/fund.ts <C…\|G…> <usdc>` | treasury → any address, USDC SAC transfer (top up a demo wallet for the 100 USDC beat)     |
| `bun scripts/demo/pay.ts [--mcp]`          | pays the demo seller once from `BUYER` with the stock x402 client, repeats the id (dedup)  |
| `bun scripts/demo/ttl.ts [--extend]`       | TTLs of the shared contracts (policy, verifiers, account WASM, router); extends short ones |
| `bun scripts/demo/oz-key.ts`               | OpenZeppelin Channels testnet key → `apps/seller/.dev.vars` (`OZ_FACILITATOR_KEY`)         |
| `bun scripts/demo/rehearse.ts`, `probe.ts` | the nine-step rehearsal and the demo-day health probe (see their headers)                  |

## Accounts

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

## How the service (A1) and the chain package (A2) get the relayer and treasury keys

`apps/web/alchemy.run.ts` binds **Worker secrets named `RELAYER_SECRET`, `TREASURY_SECRET`, `OZ_FACILITATOR_KEY` and
`DEMO_RECIPIENT_SECRET`** (`Config.Redacted`), read from the stage's gitignored env file `apps/web/.env.<stage>` or else
from the shell. Copy them in without printing them (append once; the file is A1's, gitignored by `.env.*`):

```sh
umask 077
{
  grep -E '^(RELAYER|TREASURY)_SECRET=' scripts/demo/.env
  grep -E '^CAROL_SECRET=' scripts/demo/.env | sed 's/^CAROL_SECRET=/DEMO_RECIPIENT_SECRET=/'   # if the claim page signs as demo Carol
  grep -E '^OZ_FACILITATOR_KEY=' apps/seller/.dev.vars                                        # or a fresh one: bun scripts/demo/oz-key.ts
} >> apps/web/.env.testnet
bun run deploy:testnet
```

`packages/stellar` (A2) receives both only as `Redacted` values through its layer; it never reads this file. Rules:

- **Relayer**: ≥ 500 XLM at all times (`probe.ts` flags it). S5 measured ~50 XLM per connection per day plus 1.5 XLM
  locked per open pocket. Top up with `bun scripts/demo/seed.ts --only RELAYER` (merges a fresh friendbot account in
  when under 500 XLM).
- **Treasury**: 10 USDC per new wallet, so 300 USDC covers ~25 wallets plus rehearsals. Rebuy with
  `bun scripts/demo/seed.ts --only TREASURY --treasury 300` (path payment on the testnet DEX, ~1.15 XLM per USDC).
- The public addresses the service needs for contacts are in `seeds.json → contacts` (Alice `C…`, Bob `G…`, Carol `G…`).
  Seed them as the owner's saved contacts when a wallet is created.
- Carol stops being `trustline_required` once a claim lands. To reuse her, send her USDC back to the treasury and remove
  the trustline (the rehearsal does this at the end), or create a fresh Carol: delete `CAROL_SECRET` and rerun the seed.
