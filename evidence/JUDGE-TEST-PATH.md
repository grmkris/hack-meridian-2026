# Nod: judge test path (draft)

Status: **full deployed rehearsal passed 2026-10-25 19:16 UTC** against release `5253df0`
(`bun scripts/demo/rehearse.ts --target testnet`, [run.json](demo/2026-10-25T19-14-24-616Z/run.json)): every step
s1–s11 green, acceptance checks 1, 2 and 4–9 pass, check 3 cites the forced-over-limit spike. Live endpoints were
checked on the same release at 19:12 UTC ([smoke receipt](probe/smoke-testnet-2026-10-25T19-12-49Z.json), 9 checks) and
by `probe.ts` at 19:18 UTC ([probe](probe/2026-10-25T19-18-16-039Z.json)).
Testnet only: the path uses testnet tokens and testnet transactions.

## What you need

- Claude: a claude.ai account (any plan allows one custom connector) or Claude Code.
- A device that can create a passkey (Touch ID, Windows Hello, Android, a security key). No wallet app, no seed phrase,
  no XLM.
- About ten minutes.

| Thing                    | Value                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Connector URL (MCP)      | `https://testnet.trynod.si/mcp` (live; OAuth authentication required)                                                     |
| Wallet site              | [Open Nod](https://testnet.trynod.si)                                                                                       |
| Demo seller (x402)       | `https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief` (live: 0.10 USDC on `stellar:testnet`)                 |
| Network, asset           | Stellar testnet, Circle testnet USDC (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`)                       |
| Contacts in every wallet | Alice `CCHECHAS…SO4Q` (smart account), Bob `GACQCAQZ…NGIY` (USDC ready), Carol `GALY5TMI…UUAK` (no USDC trustline)          |

## 1. Connect Claude (2 minutes)

**claude.ai** (also shows up in Claude Desktop): Settings → Connectors → **Add custom connector**. Name
`Nod`, URL = the connector URL above. Leave **Advanced settings → OAuth Client ID / Secret empty** (Claude
identifies itself with its published client metadata; nothing to register). Press **Add**, then **Connect**.

**Claude Code** instead:

```sh
claude mcp add --transport http -s user nod https://testnet.trynod.si/mcp
claude                      # then /mcp → nod → Authenticate
```

**You should see** our consent page, saying "Connect **Claude** … Published by **claude.ai**" (Claude Code: "Claude
Code"), and where access is sent (`claude.ai`, or `localhost` for Claude Code).

1. **Create a passkey wallet** on that page. Nod deploys your OpenZeppelin smart account (and pays the network fee) and
   sends it **10 testnet USDC**. The 19:14 UTC rehearsal created
   [this funded wallet](https://stellar.expert/explorer/testnet/contract/CDE4KSAHEDFVZ6SDX6WZGH5JEE3R4BIBTLKOPKJRW54FY6A6KUE2ROYX).
2. Read the allowance: "Allow **Claude** to spend up to **5 USDC** total from **Personal** until **tomorrow 12:00**.
   Larger payments need your passkey." Press **Allow**; your passkey signs the allowance onto your Stellar account.
3. You are back in Claude, connected. In a new chat, enable the Nod tools.

## 2. The nine steps (type these prompts)

Amounts fit the 10 USDC the wallet starts with (the rehearsal and the sample run use the same amounts). The two numbers
to watch in every answer: **wallet balance** and **remaining allowance**.

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
claim link itself, open [`/sample`](https://testnet.trynod.si/sample), which runs it on
Nod's own wallet and resets Carol after each run.

Every receipt links to `stellar.expert`. The smart-account transactions are paid by a Nod relayer; the x402 settlement
is paid by the facilitator. The current relayer addresses are published at
[`/api/health`](https://testnet.trynod.si/api/health) under `chain.relayers` (the deployed
stage uses different relayers from the local reference run). Your wallet holds **0 XLM**.

## 3. Reference run (explorer links)

The [19:14 UTC run](demo/2026-10-25T19-14-24-616Z/run.json) drove the deployed Worker (`5253df0`) through Claude's
path headlessly: OAuth with a new passkey wallet holding 10 USDC, then the one-number beats: allowance 5, the brief for
0.10 over x402 (4.90 left), Alice 2 inside the allowance (2.90 left), Bob 5 needs the nod and is approved with the
passkey, the same request again gives the same receipt, Alice 4 needs the nod (left unapproved), Carol 1 by claim link,
revoke. It took 133 s. Fees are in stroops; smart-account transactions are paid by Nod's relayers `GBCALSA3…` and
`GAWYWVMH…`, the x402 settlement by OpenZeppelin Channels (fee bump `GA6THKUY…`).

| Step | What                                                         | Fee (stroops) | Transaction                                                                                                              |
| ---- | ------------------------------------------------------------ | ------------: | ------------------------------------------------------------------------------------------------------------------------ |
| 4    | x402: 1.00 USDC from the wallet into the AI app's pocket     |       407,208 | [2ecaef08…](https://stellar.expert/explorer/testnet/tx/2ecaef088b748c3de3d3cf70b37699cbe4a934f384c44742f53056def49dcdad) |
| 4    | x402: pocket pays the seller 0.10 (OpenZeppelin Channels)    |        11,637 | [0fbbbed6…](https://stellar.expert/explorer/testnet/tx/0fbbbed63eec68b2c3d68860b2555d1fe0c94614e4af317a1d4130791b515e1c) |
| 5    | 2 USDC to Alice inside the allowance (2.90 left)             |        47,468 | [21d29908…](https://stellar.expert/explorer/testnet/tx/21d29908d5e68047c6ed9faba198c9d3760b02bdf8bce66a9dac2570f88bb3b9) |
| 7    | 5 USDC to Bob, approved with the passkey                     |        12,949 | [d5ea13b1…](https://stellar.expert/explorer/testnet/tx/d5ea13b1f9263888c8b9795d1383200bdbc6f5d5ec70182b5876dbf57a0202aa) |
| 10   | Carol: USDC trustline + 1 USDC in one transaction (CAP-73)   |        20,034 | [13d1b05f…](https://stellar.expert/explorer/testnet/tx/13d1b05fb6a69e488b924b5a354fa33a43bd1211f03041ace384feeb5485e263) |
| 9    | allowance removed from the account onchain                   |        20,014 | [c24b051f…](https://stellar.expert/explorer/testnet/tx/c24b051f845a31345f4fc28c74bb4fd5308ada1fed4ef3d2abb6e84480cf0ea7) |
| 9    | the pocket's 0.90 swept back to the wallet                   |        10,826 | [9c3e9b1e…](https://stellar.expert/explorer/testnet/tx/9c3e9b1e61ed1ec7a3037c72da4b566a441a45f812207c461f233b0acea11df5) |
| 3    | over-allowance transfer rejected onchain (`#3221`, spike S1) |             – | [3daf4b00…](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a) |

The pocket move is the first transaction under a new allowance and pays the storage rent for the policy's new entry;
testnet rent is back at its floor (`/api/health` → `rent_factor` 0.1), so it costs about 0.04 XLM (the 15:12 UTC run paid
91 XLM at ~219× rent). Earlier
separate checks: the demo seller settled through x402.org ([73290009…](https://stellar.expert/explorer/testnet/tx/73290009ae67ee94a5db1a53e44009b84e771edca240a61a5d70c16575fae554))
and OpenZeppelin Channels ([5dd944b0…](https://stellar.expert/explorer/testnet/tx/5dd944b054a71511673cdbbecc8e6f780e2950049968332d69f972b73fb165af)),
Alice's smart account was deployed ([992066b6…](https://stellar.expert/explorer/testnet/tx/992066b615bfd675fcab4341dd611f706c41d5695efe2cb9568165f1379726e3)),
and the shared policy contract was kept alive ([19339ef0…](https://stellar.expert/explorer/testnet/tx/19339ef0102e3941c986172b3dde3c3eeec4bcbf66488f9e0dbdf8d3a13ae136)).
The previous reference run is [15:12 UTC on `19e1c13`](demo/2026-10-25T15-12-52-316Z/run.json) (30 USDC beats, before
the one-number allowance).

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
5. `bun scripts/demo/rehearse.ts --target testnet` (tops its new wallet up to 10 USDC; Alice 2, dinner 5, 4 over,
   Carol 1) → steps
   s1–s11 green, acceptance 1, 2, 4–9 PASS, 3 REF. Paste the new
   hashes into section 3.
6. Open this page in a private window and follow section 1 with a fresh passkey.
