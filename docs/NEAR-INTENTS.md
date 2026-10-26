# NEAR Intents top-ups

The top-up integration uses 1Click to pay Stellar USDC into a wallet's classic deposit address. Nod's deposit router
then sweeps it to the passkey wallet. The [deposit design](spikes/s8-deposit.md) explains why the payout goes to a
classic `G…` address with a trustline and no memo.

## Evidence boundary

The repository records deployed top-up routes and tools plus a
[dry quote through Nod's own client](../evidence/topup/dry-quote-2026-10-25T22-07-19-789Z.json):
5 USDC on Base quoted about 4.98 USDC on Stellar in about 50 seconds. The
[deployment log](../evidence/deployments/2026-10-25.md) records the `843bdfd` testnet and `f6510d0` mainnet releases.
A funded cross-chain top-up is not proven by that quote. Keep this distinction in the [pitch](PITCH.md) and
[submission](SUBMISSION.md); ordinary Stellar deposits have their own separate
[mainnet proof](../evidence/mainnet/deposit-2026-10-25T21-46Z.md).

## Flow A: top up from another chain

[`topup.ts`](../apps/web/src/server/topup.ts) owns the 1Click client and quote lifecycle. D1 stores quotes in
[`0012_topups.sql`](../apps/web/src/server/migrations/0012_topups.sql); the wallet's Durable Object polls pending
quotes and journals events.

- `GET /api/topup/assets` lists supported origin assets.
- `POST /api/wallet/topup/quote` takes `origin_asset`, `amount`, and `refund_to`; it ensures a deposit address,
  requests a quote, and returns where to send the funds and when the quote expires.
- `GET /api/wallet/topup/:id` reports progress. `arrived` requires a recorded sweep, not only a successful quote.
- `wallet_topup_quote` and `wallet_topup_status` expose the same flow over MCP. `wallet_overview.low_balance` lets the
  agent offer funding when the wallet holds less than the allowance.
- The Add money interface offers From another chain. Testnet reports `topup_unavailable`; local tests exercise the
  lifecycle with a stand-in provider.

The [HTTP schemas](../packages/api/src/index.ts), [tool schemas](../packages/protocol/src/tools.ts), and
[agent guide](../apps/web/public/skill/nod-guide/SKILL.md) define the current inputs and results.

## API observations (25 October 2026, 21:00–21:40 UTC)

- Token list `GET https://1click.chaindefuser.com/v0/tokens`: 205 assets on 37 chains; Stellar has XLM and USDC
  (`nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu`, Circle's issuer
  `GA5ZSEJY…`). Base USDC `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`, Solana USDC
  `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`.
- Quotes (`POST /v0/quote`, `dry: true`): 5 USDC on Base → 4.9817919 USDC on Stellar, ~50 s; from Solana ~35 s;
  0.5 USDC on Stellar → 0.497498 on Base, ~27 s. Fee about 0.36 %.
- A Stellar-origin quote needs `depositMode: "MEMO"` and returns a shared deposit `G…` plus a **numeric** memo
  (`209891359`), so a contract account can pay it as a muxed `M…` address (SAC `transfer` takes `MuxedAddress` since
  Protocol 23; see the Stellar docs "Sending to a muxed address").
- EVM addresses must be **lowercase** hex (checksummed is "not valid"); Solana base58 passes. Requests need a browser
  User-Agent (the default Python agent gets Cloudflare error 1010). No JWT needed; one is optional for fee sharing.
- Status: `GET /v0/status?depositAddress=…` (plus `depositMemo` when the quote had one): PENDING_DEPOSIT → PROCESSING
  → SUCCESS with `swapDetails.destinationChainTxHashes`.
- 1Click has no testnet. Live top-ups run on mainnet; local tests use a stand-in client.

## Sending out to another chain

Cross-chain withdrawals remain future work. The research found that a Stellar-origin 1Click quote returns a classic
address plus a numeric memo, which could be encoded as a muxed address for a contract-account transfer. No withdrawal
route or tool is claimed here. The old implementation queue and deadline are retained only in Git history.
