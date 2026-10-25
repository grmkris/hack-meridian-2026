# Nod: judge test path (draft)

Status: **live endpoints checked 2026-10-25 14:33 UTC; full deployed payment rehearsal pending**. The site and MCP
connector are deployed at release `c80a786`; all nine HTTP smoke checks passed
([receipt](review/2026-10-25-testnet-smoke.json)).
The recorded real-chain rehearsal below used the local Worker against Stellar testnet and still had one failing payment.
The steps here describe the intended complete path; rerun them after the pending fee-ceiling deployment before recording.
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

Every receipt links to `stellar.expert`. The smart-account transactions are paid by a Nod relayer; the x402 settlement
is paid by the facilitator. The current relayer addresses are published at
[`/api/health`](https://hack-meridian-testnet.kristjan-grm11775.workers.dev/api/health) under `chain.relayers` (the deployed
stage uses different relayers from the local reference run). Your wallet holds **0 XLM**.

## 3. Reference run (explorer links)

The [13:38 UTC run](demo/2026-10-25T13-38-30-890Z/run.json) used the local Worker with real Stellar testnet transactions.
It passed acceptance checks 1, 2, 4, 5, 6, 8 and 9; check 3 cites the earlier forced-over-limit spike. Check 7 failed
because the delegated 2 USDC payment to Alice exceeded the then-configured fee ceiling. The fee-ceiling fix is committed
and awaits deployment and a fresh rehearsal. The Bob and Carol links below prove the recorded demo amounts (20 and
5 USDC), not the smaller self-serve amounts above. The seller and setup transactions are separate earlier checks.

| What                                                    | Transaction                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| x402 settlement, HTTP route, x402.org facilitator       | [73290009…](https://stellar.expert/explorer/testnet/tx/73290009ae67ee94a5db1a53e44009b84e771edca240a61a5d70c16575fae554) |
| x402 settlement, MCP tool `market_brief`, x402.org      | [29be4c03…](https://stellar.expert/explorer/testnet/tx/29be4c0309d6b08cb114daea11554d9490be6d2634850e46c402b761aa0fbbba) |
| x402 settlement, HTTP route, OpenZeppelin Channels      | [5dd944b0…](https://stellar.expert/explorer/testnet/tx/5dd944b054a71511673cdbbecc8e6f780e2950049968332d69f972b73fb165af) |
| Alice's smart account deployed (contact `C…`)           | [992066b6…](https://stellar.expert/explorer/testnet/tx/992066b615bfd675fcab4341dd611f706c41d5695efe2cb9568165f1379726e3) |
| Treasury bought 300 testnet USDC on the DEX             | [1c89d8ce…](https://stellar.expert/explorer/testnet/tx/1c89d8cedaa1b187bdecca4d51b1e7a61a175ec2d3b9b4235e67642ba19f6781) |
| Shared allowance policy contract kept alive (TTL)       | [19339ef0…](https://stellar.expert/explorer/testnet/tx/19339ef0102e3941c986172b3dde3c3eeec4bcbf66488f9e0dbdf8d3a13ae136) |
| Product x402 pull into the pocket (step 4, local Worker) | [646d95c9…](https://stellar.expert/explorer/testnet/tx/646d95c918bc43e1ea22f8ffc6efd48b197344d3add94599b2e40c1248a62945) |
| Product x402 settlement (step 4, local Worker)          | [1c680612…](https://stellar.expert/explorer/testnet/tx/1c6806128d7020f4fe4aa4906c8d0158cc403dd3e1c38ba9988f649442138a19) |
| Payment inside the allowance (step 5)                   | Pending successful rerun after the fee-ceiling deployment                                                                  |
| 20 USDC approved with your nod (passkey, step 7, local Worker) | [8f9e79cb…](https://stellar.expert/explorer/testnet/tx/8f9e79cb0df7f06dd7b813988a5b6d71ad5afb32ed57e306c108303b74d44a9f) |
| Over-allowance transfer rejected onchain (`#3221`, S1)  | [3daf4b00…](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a) |
| Claim: trustline + 5 USDC in one transaction (step 10, local Worker) | [8457e9cb…](https://stellar.expert/explorer/testnet/tx/8457e9cb67895e86155535a37b64308a60bfb3112c6050b60049537860536bf1) |
| Allowance removed onchain on revoke (step 9)            | Chain read passed in the local run; removal transaction link pending a fresh run with the committed receipt fix             |

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
