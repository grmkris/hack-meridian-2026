# NEAR Intents: top up a Nod wallet from any chain (and send out to any chain)

Written 2026-10-25 21:45 UTC by the orchestrator from live checks against the hosted 1Click API. Kristjan's decision
21:40 UTC: deliver the onboarding direction as part of the demo, also through MCP, so an agent can ask for a top-up when
the balance runs low. The Composed track names this: "Bring users and liquidity to Stellar: use Near Intents …".

## Why it fits what we have

1Click pays out on Stellar only to a **classic `G…` that exists, holds the asset's trustline and takes no memo**
(their SDK's `validateAddress`). That is exactly a Nod **deposit address** (`docs/spikes/s8-deposit.md`): a sponsored
`G…` per wallet, key thrown away, bound to the wallet's `C…` through the deposit router, swept automatically. So the
money path exists; the integration is a quote, a status poll and a card tab. With **deposit-first signup** (same spike)
a brand-new wallet can be funded from another chain before it is even deployed.

## Verified facts (21:00–21:40 UTC, no API key)

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
- There is no testnet. Everything below runs on mainnet or not at all.

## Flow A (deliver): top up from another chain

1. **Prerequisite:** the deposit router on pubnet (`contracts/deposit`, token pinned to mainnet USDC
   `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`), `DEPOSIT_ROUTER_ID` in `apps/web/.env.mainnet`, HEAD
   deployed to mainnet. Relayer A pays ~1–2 XLM rent for the router and 2 XLM reserve per address (reclaimed at
   teardown). Kristjan topped up relayer A for this at 21:40 UTC.
2. **Service** (`apps/web/src/server/topup.ts`, Effect service, schemas at the boundary, fixture for tests):
   - `POST /api/wallet/topup/quote` `{ origin_asset, amount, refund_to }` → ensures the wallet's deposit address exists
     (creates it on first use, ~15 s), calls 1Click with `recipient = deposit G`, `recipientType DESTINATION_CHAIN`,
     `depositType ORIGIN_CHAIN`, `dry: false`, deadline +30 min; stores `{ wallet_id, quote_id, deposit_address,
     origin_asset, amount_in, amount_out, deadline, status }` (migration 0009, additive) → returns
     `TopupQuoteView { id, pay_to (origin-chain address), amount_in, amount_out, origin_chain, asset, deadline, status }`.
   - `GET /api/wallet/topup/:id` → proxies 1Click status, and arms the deposit watcher (same poke as a GET on the
     deposit address) so the sweep lands within ~60 s of arrival; `status` becomes `arrived` when the wallet's
     balance rose (sweep tx on the view).
   - `GET /api/topup/assets` → cached token list, filtered to stablecoins + native assets, grouped by chain.
   - 1Click calls go through one client with a fixed browser User-Agent and a 10 s timeout; failures map to
     `topup_unavailable`, never a 500.
3. **Card** (Add money, MCP-Apps session's files): a "From another chain" tab: chain and asset, amount, refund
   address on that chain (required by 1Click), "Get address" → address + QR + amount + countdown + "arrives as USDC in
   your Nod wallet", status line. Copy on mainnet only; on a network without a router the tab says deposits are next.
4. **MCP tools** (additive, both lanes, descriptions in the product's voice):
   - `wallet_topup_quote { origin_chain, asset, amount, refund_address }` → the same view; text: "Send 5 USDC on Base
     to 0x… within 30 minutes; it arrives as about 4.98 USDC in your Nod wallet." Plus `structuredContent` and a link
     to the wallet's Add money card.
   - `wallet_topup_status { id }` → status and, when arrived, the sweep receipt.
   - `wallet_overview` gains `low_balance` (balance below the agent's remaining allowance) so the model can offer a
     top-up unprompted.
5. **Live test** (Kristjan, ~5 USDC from Base or Solana): quote → pay → status SUCCESS → sweep tx → wallet balance.
   Evidence to `evidence/mainnet/topup-<time>.md` with the 1Click status JSON and both hashes.

## Flow B (stretch, after A): send out to another chain

1. **Muxed destinations** (`packages/stellar`): a contact destination with a numeric memo becomes an `M…` at transfer
   time (`new Address('M…').toScVal()`); readiness checks the underlying `G…`'s trustline; receipts show `G…` and the
   id. This also fixes paying exchange deposit addresses.
2. `POST /api/wallet/withdraw/quote` `{ destination_asset, amount, recipient }` → 1Click with `depositMode MEMO` →
   `G… + memo` → an **owner-lane payment intent** to `M(G, memo)` for `amount` (the nod page shows "to NEAR Intents,
   arrives on Base as ~0.4975 USDC") → after confirmation the view polls 1Click until the destination hash exists.
3. Tool `wallet_withdraw_quote` on the same shape. Test with 0.5 USDC.

## Gates and ownership

- Build: an Opus agent under the delivery session (`nod-hackathon-delivery-orchestration`), pathspec commits,
  `heavy bun run check`, additive hunks in the MCP-Apps session's files.
- Deploy: `nod-mcp-apps-wallet` per `docs/DEPLOY.md` ("19:10 UTC"): router on pubnet first (Kristjan's go given with
  the XLM at 21:40 UTC), then testnet HEAD, then mainnet HEAD; never during a recording.
- Freeze 04:00 UTC. If Flow A is not green on mainnet with a real top-up by then, the card tab and the tools stay
  behind the `topup_unavailable` answer and the pitch keeps "top up from any chain via NEAR Intents" as the next line,
  backed by the live quotes above.
