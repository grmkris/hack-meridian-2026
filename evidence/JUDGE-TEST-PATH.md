# Nod: judge test path (draft)

Status: **full deployed rehearsal passed 2026-10-25 15:12 UTC** against release `19e1c13`
(`bun scripts/demo/rehearse.ts --target testnet`): every step s1–s11 green, acceptance checks 1, 2 and 4–9 pass, check 3
cites the forced-over-limit spike. Live endpoints were checked at 14:33 UTC
([smoke receipt](review/2026-10-25-testnet-smoke.json)) and by `probe.ts` at 13:45 UTC.
Testnet only: the path uses testnet tokens and testnet transactions.

## What you need

- Claude: a claude.ai account (any plan allows one custom connector) or Claude Code.
- A device that can create a passkey (Touch ID, Windows Hello, Android, a security key). No wallet app, no seed phrase,
  no XLM.
- About ten minutes.

| Thing                    | Value                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Connector URL (MCP)      | `https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp` (live; OAuth authentication required) |
| Wallet site              | [Open Nod](https://hack-meridian-testnet.kristjan-grm11775.workers.dev)                                               |
| Demo seller (x402)       | `https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief` (live: 0.10 USDC on `stellar:testnet`)                 |
| Network, asset           | Stellar testnet, Circle testnet USDC (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`)                       |
| Contacts in every wallet | Alice `CCHECHAS…SO4Q` (smart account), Bob `GACQCAQZ…NGIY` (USDC ready), Carol `GALY5TMI…UUAK` (no USDC trustline)          |

## 1. Connect Claude (2 minutes)

**claude.ai** (also shows up in Claude Desktop): Settings → Connectors → **Add custom connector**. Name
`Nod`, URL = the connector URL above. Leave **Advanced settings → OAuth Client ID / Secret empty** (Claude
identifies itself with its published client metadata; nothing to register). Press **Add**, then **Connect**.

**Claude Code** instead:

```sh
claude mcp add --transport http -s user nod https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp
claude                      # then /mcp → nod → Authenticate
```

**You should see** our consent page, saying "Connect **Claude** … Published by **claude.ai**" (Claude Code: "Claude
Code"), and where access is sent (`claude.ai`, or `localhost` for Claude Code).

1. **Create a passkey wallet** on that page. Nod deploys your OpenZeppelin smart account (and pays the network fee) and
   sends it **10 testnet USDC**. The deployed passkey check created
   [this funded wallet](https://stellar.expert/explorer/testnet/contract/CCDOHIGFC4Y2EYZWA66HULNXUI3PX3OD3WX27OKGPEHLRR3LDR3OBZG4).
2. Read the allowance: "Allow **Claude** to spend up to **5 USDC** total from **Personal** until **tomorrow 12:00**.
   Larger payments need your passkey." Press **Allow**; your passkey signs the allowance onto your Stellar account.
3. You are back in Claude, connected. In a new chat, enable the Nod tools.

## 2. The nine steps (type these prompts)

Amounts fit the 10 USDC the wallet starts with (the recorded demo uses a 30 USDC wallet and a 20 USDC dinner; same
steps). The two numbers to watch in every answer: **wallet balance** and **remaining allowance**.

| #   | Prompt                                                                                        | What you should see                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | "Show my Nod wallet overview."                                                                | `wallet_overview`: balance **10 USDC**, allowance **5.00** remaining, expiry tomorrow 12:00, no pending approvals                                                                                                                                                                                                               |
| 4 | "Buy the market brief at https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief." | `paid_resource_fetch`: the brief (XLM/USDC on the testnet DEX) and a receipt with **two** explorer links: Nod moves 1.00 USDC from your wallet into this AI app's pocket, then the pocket pays the seller 0.10 through a public facilitator. Allowance **4.90**; the 0.90 left in the pocket pays for the next purchase and comes back to you on revoke. No prompt |
| 5   | "Send Alice 2 USDC."                                                                          | `payment_prepare` → `payment_execute`: confirmed receipt, explorer link, allowance **2.90**. Nod pays the network fee, not you                                                                                                                                                                                                  |
| 6   | "Pay Bob 5 USDC for dinner."                                                                  | it **needs your nod** (5 > 2.90 left; `awaiting_approval`) and Claude shows an **approval link**. Nothing is paid yet                                                                                                                                                                                                           |
| 7   | Open the link                                                                                 | Bob's name **and** address `GACQCAQZ…NGIY`, **5 USDC**, testnet, fee ceiling, "requested by Claude", the agent's reason marked as its claim. Approve with your passkey. Then ask Claude "is it paid?" → `payment_status` **confirmed** with a receipt; allowance still **2.90** (payments you approve do not use the allowance) |
| 8   | "Retry that same dinner payment using the same idempotency key; do not create a new payment." | the **same** payment id and receipt; no second payment (Bob's balance on the explorer moves once). Repeating only the wording does not guarantee that the AI app reuses the key                                                                                                                                                    |
| 8b  | "Send Alice 4 USDC."                                                                          | it **needs your nod**: 4 > 2.90 left. Nod asks you instead of signing; nothing reaches the chain. Leave it unapproved                                                                                                                                                                                                           |
| 10 | "Send Carol 1 USDC." (CAP-73 claim link) | Carol shows as **Trustline required**, so it **needs your nod**: approve with your passkey, then open the **claim link** as Carol and press **Accept with the demo wallet** (testnet: the server holds the demo Carol key). One transaction creates her USDC trustline and pays her; the receipt links to it |
| 9 | Wallet site → **Connections** → **Revoke** Claude (confirm), then **Remove rule** with your passkey; ask Claude "Send Alice 0.50 USDC." | the site marks Claude revoked, removes the allowance from your account onchain, and sweeps the pocket's 0.90 back to your wallet; Claude's next call is refused (it is asked to reconnect) |

Carol is one shared demo recipient. If another judge or the sample run onboarded her minutes earlier, step 10 shows her
as **USDC ready** and Claude makes an ordinary payment instead of a claim link; that payment still succeeds. To see the
claim link itself, open [`/sample`](https://hack-meridian-testnet.kristjan-grm11775.workers.dev/sample), which runs it on
Nod's own wallet and resets Carol after each run (from the next deploy).

Every receipt links to `stellar.expert`. The smart-account transactions are paid by a Nod relayer; the x402 settlement
is paid by the facilitator. The current relayer addresses are published at
[`/api/health`](https://hack-meridian-testnet.kristjan-grm11775.workers.dev/api/health) under `chain.relayers` (the deployed
stage uses different relayers from the local reference run). Your wallet holds **0 XLM**.

## 3. Reference run (explorer links)

The [15:12 UTC run](demo/2026-10-25T15-12-52-316Z/run.json) drove the deployed Worker (`19e1c13`) through Claude's
path headlessly: OAuth with a new passkey wallet, then the recorded demo amounts (30 USDC wallet, 0.10 x402, 2 to Alice,
20 to Bob with the passkey, 4 over the allowance, 5 to Carol by claim link, revoke). It took 204 s. Fees are in stroops;
smart-account transactions are paid by Nod's relayers `GBCALSA3…` and `GAWYWVMH…`, the x402 settlement by OpenZeppelin
Channels (fee bump `GA6THKUY…`).

| Step | What                                                         | Fee (stroops) | Transaction                                                                                                              |
| ---- | ------------------------------------------------------------ | ------------: | ------------------------------------------------------------------------------------------------------------------------ |
| 4    | x402: 1.00 USDC from the wallet into the AI app's pocket     |   909,648,553 | [97847912…](https://stellar.expert/explorer/testnet/tx/978479126c9339de3a2cf4140dcef4958aa13d95ea39408b50cbf4ae413ed702) |
| 4    | x402: pocket pays the seller 0.10 (OpenZeppelin Channels)    |        63,263 | [e3e62e07…](https://stellar.expert/explorer/testnet/tx/e3e62e07dbf11f0bd75ac795a3bef5a50fcc6ffd64e610c98a70dc9676890990) |
| 5    | 2 USDC to Alice inside the allowance                         |    78,350,140 | [fb77bd0f…](https://stellar.expert/explorer/testnet/tx/fb77bd0f01aeb515b967e7bf5f7d0b1f8ec5c4c6af7889263ed3172a0a8ebefe) |
| 7    | 20 USDC to Bob, approved with the passkey                    |        61,945 | [fbfd200c…](https://stellar.expert/explorer/testnet/tx/fbfd200cc85525ee65a0a55f4b3dc338eedf37c1c8273abcc0ac7701f09e97da) |
| 10   | Carol: USDC trustline + 5 USDC in one transaction (CAP-73)   |       120,656 | [565b7f07…](https://stellar.expert/explorer/testnet/tx/565b7f0740d2cb73975939107c6b3329a03d60d26925101ba7e9a7ae5660735c) |
| 9    | allowance removed from the account onchain                   |        69,010 | [55beab6d…](https://stellar.expert/explorer/testnet/tx/55beab6dd2866dd95f6bfcc7209d4c3c7e8a423d4955de5607a6009da1003279) |
| 9    | the pocket's 0.90 swept back to the wallet                   |        62,452 | [00129674…](https://stellar.expert/explorer/testnet/tx/00129674edaed2fcce96c73745587f2c599704850c182c38f7d7c12ab5ee55a6) |
| 3    | over-allowance transfer rejected onchain (`#3221`, spike S1) |             – | [3daf4b00…](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a) |

The large fee on the pocket move is storage rent: testnet's rent factor was ~219× normal at the time (S1, S5). Earlier
separate checks: the demo seller settled through x402.org ([73290009…](https://stellar.expert/explorer/testnet/tx/73290009ae67ee94a5db1a53e44009b84e771edca240a61a5d70c16575fae554))
and OpenZeppelin Channels ([5dd944b0…](https://stellar.expert/explorer/testnet/tx/5dd944b054a71511673cdbbecc8e6f780e2950049968332d69f972b73fb165af)),
Alice's smart account was deployed ([992066b6…](https://stellar.expert/explorer/testnet/tx/992066b615bfd675fcab4341dd611f706c41d5695efe2cb9568165f1379726e3)),
and the shared policy contract was kept alive ([19339ef0…](https://stellar.expert/explorer/testnet/tx/19339ef0102e3941c986172b3dde3c3eeec4bcbf66488f9e0dbdf8d3a13ae136)).

## If something goes wrong

- The consent page says "Cannot authorize": your Claude sent an unknown client; try again from a fresh connector.
- An answer has no allowance numbers: ask "show my wallet overview".
- A payment stays `submitted` for more than a minute: ask for `payment_status` again; testnet ledgers close every 5 s.
- Everything else: the probe below shows which part is down.

## Demo-day checklist (operators, not judges)

Run from the repository root on the build box.

1. `bun scripts/demo/probe.ts --target testnet --save` → all green. It checks both facilitators, the seller, our `/mcp`
   and OAuth metadata, tools/list when a saved connection is available, the relayers (≥ 500 XLM), the treasury
   (≥ 50 USDC) and the shared-contract TTLs. A skipped tools/list check is not proof of an authenticated connection.
2. **Extend TTLs**: if the probe flags any shared contract under 7 days, `bun scripts/demo/ttl.ts --extend` (the OPS
   account pays; the spending-limit policy's WASM costs ~60 XLM per day at today's testnet rent, in ≤ 420 XLM
   transactions). Current: policy and router live to ledger ~5,692,570 ≈ **12 Nov 12:27 UTC**; the Ed25519 verifier
   instance to 19 Nov; everything else to 2027. Evidence in `evidence/ttl/`.
3. Relayer below 500 XLM: `bun scripts/demo/seed.ts --only RELAYER`. Treasury below 50 USDC:
   `bun scripts/demo/seed.ts --only TREASURY --treasury 300`.
4. Carol must be `trustline_required`: the rehearsal returns her USDC and removes her trustline at the end; check with
   `bun scripts/demo/seed.ts --table` (Carol's USDC column reads "no trustline").
5. `bun scripts/demo/rehearse.ts --target testnet` (tops its new wallet up to 30 USDC; dinner 20, Carol 5) → steps
   s1–s11 green, acceptance 1, 2, 4–9 PASS, 3 REF. Paste the new
   hashes into section 3.
6. Open this page in a private window and follow section 1 with a fresh passkey.
