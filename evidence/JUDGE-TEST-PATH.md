# Nod: judge test path (draft)

Status: **draft, 2026-10-25 12:55 UTC**, stream C. Everything marked **PLACEHOLDER** is filled in once the wallet
service (stream A1) is deployed and `bun scripts/demo/rehearse.ts --target testnet` has passed against it. Testnet only:
no real money moves anywhere on this path.

## What you need

- Claude: a claude.ai account (any plan allows one custom connector) or Claude Code.
- A device that can create a passkey (Touch ID, Windows Hello, Android, a security key). No wallet app, no seed phrase,
  no XLM.
- About ten minutes.

| Thing                    | Value                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Connector URL (MCP)      | **PLACEHOLDER** `https://hack-meridian-testnet.kristjan-grm11775.workers.dev/mcp` (the testnet stage; 404 until A1 deploys) |
| Wallet site              | **PLACEHOLDER** `https://hack-meridian-testnet.kristjan-grm11775.workers.dev`                                               |
| Demo seller (x402)       | `https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief` (live: 0.10 USDC on `stellar:testnet`)                 |
| Network, asset           | Stellar testnet, Circle testnet USDC (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`)                       |
| Contacts in every wallet | Alice `CCHECHAS…SO4Q` (smart account), Bob `GACQCAQZ…NGIY` (USDC ready), Carol `GALY5TMI…UUAK` (no USDC trustline)          |

## 1. Connect Claude (2 minutes)

**claude.ai** (also shows up in Claude Desktop): Settings → Connectors → **Add custom connector**. Name
`Nod`, URL = the connector URL above. Leave **Advanced settings → OAuth Client ID / Secret empty** (Claude
identifies itself with its published client metadata; nothing to register). Press **Add**, then **Connect**.

**Claude Code** instead:

```sh
claude mcp add --transport http -s user nod <connector URL>
claude                      # then /mcp → nod → Authenticate
```

**You should see** our consent page, saying "Connect **Claude** … Published by **claude.ai**" (Claude Code: "Claude
Code"), and where access is sent (`claude.ai`, or `localhost` for Claude Code).

1. **Create a passkey wallet** on that page. Nod deploys your OpenZeppelin smart account (and pays the network fee) and
   sends it **10 testnet USDC** (PLACEHOLDER: confirm the amount with A1).
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
| 6   | "Pay Bob 5 USDC for dinner."                                                                  | it **needs your nod** (5 > 2.90 left; `requires_approval`) and Claude shows an **approval link**. Nothing is paid yet                                                                                                                                                                                                           |
| 7   | Open the link                                                                                 | Bob's name **and** address `GACQCAQZ…NGIY`, **5 USDC**, testnet, fee ceiling, "requested by Claude", the agent's reason marked as its claim. Approve with your passkey. Then ask Claude "is it paid?" → `payment_status` **confirmed** with a receipt; allowance still **2.90** (payments you approve do not use the allowance) |
| 8   | "Pay Bob 5 USDC for dinner" again in the same chat (same request)                             | the **same** payment id and receipt; no second payment (Bob's balance on the explorer moves once)                                                                                                                                                                                                                               |
| 8b  | "Send Alice 4 USDC."                                                                          | it **needs your nod**: 4 > 2.90 left. Nod asks you instead of signing; nothing reaches the chain. Leave it unapproved                                                                                                                                                                                                           |
| 10 | "Send Carol 1 USDC." (claim link, Stellar Unlocked) | Carol shows as **Trustline required**, so it **needs your nod**: approve with your passkey, then open the **claim link** as Carol and press **Accept with the demo wallet** (testnet: the server holds the demo Carol key). One transaction creates her USDC trustline and pays her; the receipt links to it |
| 9 | Wallet site → **Connections** → **Revoke** Claude (confirm), then **Remove rule** with your passkey; ask Claude "Send Alice 0.50 USDC." | the site marks Claude revoked, removes the allowance from your account onchain, and sweeps the pocket's 0.90 back to your wallet; Claude's next call is refused (it is asked to reconnect) |

Every receipt links to `stellar.expert`. On any transaction you can check that Nod paid the network fee (account
`GBGNYETY…BPT6`), never your wallet; your wallet holds **0 XLM**.

## 3. Reference run (explorer links)

PLACEHOLDER until the first green `rehearse.ts --target testnet`; that run's `evidence/demo/<utc>/run.json` lists every
hash. Real now:

| What                                                    | Transaction                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| x402 settlement, HTTP route, x402.org facilitator       | [73290009…](https://stellar.expert/explorer/testnet/tx/73290009ae67ee94a5db1a53e44009b84e771edca240a61a5d70c16575fae554) |
| x402 settlement, MCP tool `market_brief`, x402.org      | [29be4c03…](https://stellar.expert/explorer/testnet/tx/29be4c0309d6b08cb114daea11554d9490be6d2634850e46c402b761aa0fbbba) |
| x402 settlement, HTTP route, OpenZeppelin Channels      | [5dd944b0…](https://stellar.expert/explorer/testnet/tx/5dd944b054a71511673cdbbecc8e6f780e2950049968332d69f972b73fb165af) |
| Alice's smart account deployed (contact `C…`)           | [992066b6…](https://stellar.expert/explorer/testnet/tx/992066b615bfd675fcab4341dd611f706c41d5695efe2cb9568165f1379726e3) |
| Treasury bought 300 testnet USDC on the DEX             | [1c89d8ce…](https://stellar.expert/explorer/testnet/tx/1c89d8cedaa1b187bdecca4d51b1e7a61a175ec2d3b9b4235e67642ba19f6781) |
| Shared allowance policy contract kept alive (TTL)       | [19339ef0…](https://stellar.expert/explorer/testnet/tx/19339ef0102e3941c986172b3dde3c3eeec4bcbf66488f9e0dbdf8d3a13ae136) |
| Payment inside the allowance (step 5)                   | PLACEHOLDER                                                                                                              |
| Payment approved with your nod (passkey, step 7)        | PLACEHOLDER                                                                                                              |
| Over-allowance transfer rejected onchain (`#3221`, S1)  | [3daf4b00…](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a) |
| Claim: trustline + payment in one transaction (step 10) | PLACEHOLDER                                                                                                              |
| Allowance removed onchain on revoke (step 9)            | PLACEHOLDER                                                                                                              |

## If something goes wrong

- The consent page says "Cannot authorize": your Claude sent an unknown client; try again from a fresh connector.
- An answer has no allowance numbers: ask "show my wallet overview".
- A payment stays `submitted` for more than a minute: ask for `payment_status` again; testnet ledgers close every 5 s.
- Everything else: the probe below shows which part is down.

## Demo-day checklist (operators, not judges)

Run from the repository root on the build box.

1. `bun scripts/demo/probe.ts --target testnet --save` → all green. It checks both facilitators, the seller, our `/mcp`
   and OAuth metadata, tools/list, the relayer (≥ 500 XLM), the treasury (≥ 50 USDC) and the shared-contract TTLs.
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
