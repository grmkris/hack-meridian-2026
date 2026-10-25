# Nod

**Small stuff, it just pays. Big stuff needs your nod.**

Apps are turning into conversations and agents, so wallets have to follow them into the chat. Approving every call
kills an agent's autonomy and nobody trusts an AI with the whole balance, so Nod gives each AI app one allowance,
enforced on your own Stellar account.

Nod is a Stellar wallet that lives inside the AI you already use. You add it to Claude or any MCP app with one connector
URL (in ChatGPT, as a developer-mode connector). In hosts that render MCP Apps, Nod's cards appear in the chat; in hosts that take MCP Events, Nod tells
you when money arrives or a payment needs you. You sign up with a passkey and hold USDC, and you never meet XLM, a seed
phrase or a trustline. You give each AI app one allowance, say 5 USDC until tomorrow. Inside it, the app pays for APIs
over x402 and pays people on its own. Anything past it needs your passkey, every time, for any amount: Claude hands you
a link, and your passkey signs on Nod's own page, on your phone or your laptop. The allowance is an OpenZeppelin
spending-limit policy on your own Stellar account, so the most Nod's service could ever spend for an AI app is the
allowance you set, pocket included.

**The full flow runs on Stellar mainnet at [trynod.si](https://trynod.si), in claude.ai, on the founder's own wallet**:
an x402 purchase settled by OpenZeppelin Channels, a payment inside the allowance, one that needed the nod, a claim
link that created a trustline and paid in one transaction, a revoke that removed the rule and swept the pocket
([proof below](#proof-on-mainnet)).

| Host                                           | What it is                                                                                             | Connector                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------- |
| [trynod.si](https://trynod.si)                 | the product on Stellar mainnet; signup is open; the wallet holds USDC only                             | `https://trynod.si/mcp`         |
| [testnet.trynod.si](https://testnet.trynod.si) | the judges' sandbox on Stellar testnet: new wallets get 10 testnet USDC; `/sample` runs a sample agent | `https://testnet.trynod.si/mcp` |

The old `hack-meridian-testnet.kristjan-grm11775.workers.dev` host redirects to testnet.trynod.si.

Built at [HackMeridian 2026](https://www.hackmeridian.com/) (Lisbon, 25–26 October 2026): Genesis builder track,
**Stellar Composed** thematic track. Product spec: [docs/SPEC.md](docs/SPEC.md). Pitch and wording:
[docs/PITCH.md](docs/PITCH.md).

## Problem

People who use AI assistants want them to finish tasks that cost money: buy a paid API result, pay a friend back, cover
a small bill. Today they hand the assistant a card or a private key, which gives it everything, or they approve every
payment themselves, which defeats the point of an agent. Sellers of paid APIs feel it too: x402 lets agents pay per
call, but Stellar's docs note that "there is no policy layer for x402 on Stellar today", so few owners let an agent
hold money. Nod gives each AI app one allowance on the owner's account, enforced by the account, with a passkey tap for
anything past it.

## How it works

| You want…                                         | Who signs                               | What enforces it                                                    |
| ------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Claude to buy a 0.10 USDC report                  | Claude's own key, inside its allowance  | the account's context rule and spending-limit policy, with expiry   |
| Claude to send Alice 2 USDC                       | Claude's own key, inside its allowance  | the same rule; the same allowance counts both                       |
| Claude to pay Bob 5 USDC, more than the 2.90 left | **you**, with your passkey, from a link | the account checks the passkey signature over that payment          |
| to stop Claude                                    | you, on the site                        | the service stops at once; one passkey tap removes the rule onchain |

- **One number per AI app.** Connecting an app over OAuth and setting its allowance with your passkey is one step. The
  allowance is the total the app may spend on its own until it expires: a context rule on your account, separate for
  each app, revocable.
- **Past it, your nod.** A payment above what is left is never signed with the app's key. It becomes a link that shows
  the recipient's name and address, the amount and which app asked; your passkey signs that payment on Nod's page,
  whatever the amount. Payments you approve do not use the allowance.
- **Cards and notifications in the chat.** Nod serves MCP Apps cards (`ui://nod/card/v1`, `ui://nod/home/v1`): the
  wallet, a payment waiting for your nod that turns into its receipt, Nod home. It publishes MCP Events
  (`payment.received`, `payment.settled`, `approval.needed`, `allowance.changed`, `request.received`, `request.answered`) by webhook or poll. It speaks MCP over OAuth 2.1 on two lanes, the
  2025 protocol and 2026-07-28, where the nod is a native URL request.
- **Paid APIs through the open standard.** x402 sellers are paid through public facilitators (x402.org, OpenZeppelin
  Channels). Hosted x402 facilitators do not take smart-account payers yet, so each AI app's key also owns a small
  pocket account, filled from your wallet under the same policy in 1 USDC steps. Both transactions are on the receipt.
  Ask twice, pay once.
- **Pays people who have never held USDC.** A recipient without a USDC trustline gets a claim link. You nod once; they
  accept with Freighter within 30 minutes (their account needs about 0.5 XLM for the trustline reserve), and the
  trustline (through the USDC contract's `trust` function, CAP-73) and the payment land in one transaction.
- **No seed phrase, no XLM.** A passkey owns the account and Nod pays every network fee.
- **Deposit addresses, on testnet.** An exchange cannot pay a contract (`C…`) address, so each wallet can get a `G…`
  deposit address bound to it by our deposit router; anyone can sweep what arrives, and it can only go to that wallet.
  Proven on testnet ([docs/spikes/s8-deposit.md](docs/spikes/s8-deposit.md)); off on mainnet.

## Proof on mainnet

Stellar pubnet, 25 October 2026, 18:39–18:59 UTC, release `9fc080f`, through the public claude.ai connector
`https://trynod.si/mcp` on Kristjan's own wallet
[`CDOTWV7A…Y4HC`](https://stellar.expert/explorer/public/contract/CDOTWV7AICM5WKEIKQ7HTJWIPJJVZDND55VK7NOLPB7BDC76YLTNY4HC)
and his own passkey. The wallet went from 9.90 to 1.80 USDC. Record:
[`evidence/mainnet/claude-run-2026-10-25.md`](evidence/mainnet/claude-run-2026-10-25.md).

| What happened                                                                                                      | Transaction                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Claude connected with an allowance of 5 USDC until 26 October 12:00 UTC; the rule is installed on the account      | [`f803994b`](https://stellar.expert/explorer/public/tx/f803994b1f0313b0c9fe81c51355eb51296b86992c65c70e2e04effa8d73d7eb) |
| x402: Claude's key pulls 1.00 USDC into its pocket under the allowance…                                            | [`6485e55c`](https://stellar.expert/explorer/public/tx/6485e55cd8f69d51b60f608bdc253d40c3d7ee02f9b86bcccd6cefbeeb08c7bb) |
| …and OpenZeppelin Channels settles the 0.10 USDC market brief (the facilitator paid the fee); 4.90 left            | [`cb296cc3`](https://stellar.expert/explorer/public/tx/cb296cc3a539cfaf966d79fa3662e48e83e3f1fb01fe9be24b767d3c3c8dea58) |
| 2 USDC to Alice inside the allowance, fee 0.052 XLM paid by Nod; 2.90 left                                         | [`c8ee8b5a`](https://stellar.expert/explorer/public/tx/c8ee8b5ad7599b9db13a4dd551a918d55ecafc6de2f31c79a61fcc7edb1032cb) |
| 5 USDC to Bob, past the 2.90 left: claude.ai showed the approval link, Kristjan approved with his passkey          | [`0339b8dd`](https://stellar.expert/explorer/public/tx/0339b8dd088b46d500de425d0afe8707ff6922186ef70070396323f2d3312e4f) |
| The same request with the same idempotency key returned the same payment and receipt; Bob was paid once            | same                                                                                                                     |
| 4 USDC with 2.90 left waited for the nod; nothing was reserved or spent                                            | none                                                                                                                     |
| 1 USDC to Carol, who had no USDC trustline: one nod, then the claim link; trustline and payment in one transaction | [`1fe4e852`](https://stellar.expert/explorer/public/tx/1fe4e852314ea638ed53ba79acebc60a129b587e0ef80c9b051d434aa01e68c6) |
| Revoke: the pocket's unspent 0.90 USDC swept back to the wallet                                                    | [`ab6d493d`](https://stellar.expert/explorer/public/tx/ab6d493d483f6ea5d560a9561ab7cdd2668b9d7597632023095a397ca1fd53dd) |
| Revoke: the allowance rule removed from the account with the passkey; Claude's next payment was refused            | [`e17e15d5`](https://stellar.expert/explorer/public/tx/e17e15d5efd2f43e883073873ff9d5dc0333ea9dca318cea0f38a5c7678f04c9) |

Carol is Nod's own demo contact on mainnet, so her claim was accepted by Nod's demo key; a stranger accepts with
Freighter. Earlier the same evening: the first mainnet x402 settlement through OpenZeppelin Channels
([`129fbe27`](https://stellar.expert/explorer/public/tx/129fbe27c635b86b6ca1f69ccaba1e5d3eae235b58344bd1d877b97aef28d383))
and the trust-and-pay router's deploy
([`eaaf4d5f`](https://stellar.expert/explorer/public/tx/eaaf4d5f5acc58cb6a422c8066bd29b4366703fda9b7ad73bc103b4a8e6870ed)).

## Proof on testnet

One rehearsal on the live site passed acceptance tests 1, 2 and 4–9; test 3, a forced over-limit transfer, cannot be
sent through MCP by design and is proven onchain in spike S1 (`3daf4b00…`, below). The run drove the deployed release
`9fc080f` at testnet.trynod.si through Claude's path headlessly (OAuth, a new passkey wallet with 10 testnet USDC, the
one-number beats) on 25 October, 18:31–18:33 UTC. Record:
[`evidence/demo/2026-10-25T18-31-37-970Z/run.json`](evidence/demo/2026-10-25T18-31-37-970Z/run.json).

| What happened                                                                                  | Transaction                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The passkey wallet this run created                                                            | [`CDKTGG5K…BRQZ`](https://stellar.expert/explorer/testnet/contract/CDKTGG5K77NCUQIDKJ2SNYIWYE6QZZCCHV2DK5O6GQJOXI7BEUQFBRQZ) |
| x402: the AI app's key pulls 1.00 USDC into its pocket under the allowance (Nod pays the fee)… | [`cc89e564`](https://stellar.expert/explorer/testnet/tx/cc89e5646c6e7e42001a95909c2ced9fb14f104f9557c88ba0307162a8dbe2c9)    |
| …then the pocket pays the seller 0.10 USDC, settled by OpenZeppelin Channels; 4.90 left        | [`8a7b7fa4`](https://stellar.expert/explorer/testnet/tx/8a7b7fa45e3d58b5290d39836f4127f7f44a4a7af20d91646f2157bcf6b30e50)    |
| 2 USDC to Alice, signed by the AI app's key inside its allowance; 2.90 left                    | [`68d0859c`](https://stellar.expert/explorer/testnet/tx/68d0859c208e6b2508a824ad80a6808a50190df9ac75555245f7361a6c980f88)    |
| 5 USDC to Bob, past the allowance, approved with the passkey; the same request again paid once | [`e53e9d0f`](https://stellar.expert/explorer/testnet/tx/e53e9d0fb4105f8cde014510e27b6c51ceb86764f03fd0f8ea470875bc57b8ab)    |
| Carol's USDC trustline and 1 USDC in one transaction (CAP-73 claim link)                       | [`2b3abb65`](https://stellar.expert/explorer/testnet/tx/2b3abb657a536ac24c57064c4a9fde8b15082d897cf1c67e2502a84f909653aa)    |
| Revoke sweeps the pocket back to the wallet                                                    | [`14eeeb58`](https://stellar.expert/explorer/testnet/tx/14eeeb58d4099d2fad5b820ae97ce3a77c35f5e10473dcef51897bfd78b838fd)    |
| Revoke removes the allowance rule from the account                                             | [`b4b220ef`](https://stellar.expert/explorer/testnet/tx/b4b220ef177f9a0daa38cad293da559b495610fa219349219110c9c7a067dd95)    |

From the spikes that proved each risky part first (full record with commands in [docs/spikes/](docs/spikes/)):

| Claim                                                                                          | Transaction                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| An app key under a 5 USDC allowance spends exactly 5.0 (one stroop more fails)                 | [`c0f6f923`](https://stellar.expert/explorer/testnet/tx/c0f6f923936b7dc4d716454ba3e3d3f43f21ddcf353e49e3e083d054bf5f9c57) |
| An over-allowance transfer forced onchain is rejected by the account (`#3221`)                 | [`3daf4b00`](https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a) |
| A passkey-only account pays with a WebAuthn signature                                          | [`4b135c1c`](https://stellar.expert/explorer/testnet/tx/4b135c1cba6872a7cdf1ff6e314674e92635243c7f5e4cdc496ed41144888ee1) |
| A passkey installs an app's allowance                                                          | [`f3160c7e`](https://stellar.expert/explorer/testnet/tx/f3160c7e183e52c4a633804d60d50a956c627e88bc461be2f8f5fad7b14bb110) |
| A deposit address got 2 USDC; the router swept it into the wallet with no one's signature (S8) | [`efcbcc48`](https://stellar.expert/explorer/testnet/tx/efcbcc48ba6860d72243ff97eaa7d3e082218b312438d8b5969282936e9d2017) |

## Shown in real hosts

Nod's cards and the nod run live in three hosts, all against testnet.trynod.si
([`evidence/mcp-apps/README.md`](evidence/mcp-apps/README.md), screenshots beside it). In **Goblin**, Kristjan's own MCP
host, the wallet card renders, a payment past the allowance comes back as a URL request that the passkey approves
([`63a28bf9`](https://stellar.expert/explorer/testnet/tx/63a28bf9313214cf0be47aec5eb1b7de5076a913c265c9846fb3a253d89c78b8)),
and `payment.received` arrives by webhook from the chain watcher
([`091942b4`](https://stellar.expert/explorer/testnet/tx/091942b4b7becb61161308840e4a6b4b75fa2df01080ce0a1377fd26ea80497b)).
In **claude.ai**, the wallet card renders, a payment inside the allowance flips to its receipt, and the one past it
shows as claude.ai's own "wants to open a URL" with the approval link
([`0d28f53a`](https://stellar.expert/explorer/testnet/tx/0d28f53ae201217621ec1554c3652e0ee85ba55d704a9decddf0ccf733e6bebe)).
Nod works in **ChatGPT** as a developer-mode connector (cards, the nod, events): the card flips to the receipt after
the passkey
([`88973525`](https://stellar.expert/explorer/testnet/tx/8897352589059b4d53a17df1c4d038506c9f6b863c2379fc143dac460ba77eb2)),
and a 1 USDC transfer woke a subscribed chat within 4 seconds
([`c85e7693`](https://stellar.expert/explorer/testnet/tx/c85e7693d96237bb642a96a2a03c0e5415db39ae50ff87604bcc89d64eaaba95));
it is not listed in ChatGPT's app store, whose policy bars crypto transfers. claude.ai and Claude Code do not implement
MCP Events, so there the cards poll. Claude Code connected over OAuth in spike S4. The mainnet run above went through
claude.ai.

## Demo instructions

**Judges: use the sandbox at testnet.trynod.si.** Everything runs on Stellar testnet with testnet USDC, and new wallets
receive 10 testnet USDC. You need Claude (claude.ai, Claude Desktop or Claude Code) and a device that can create a
passkey. The same steps work on mainnet at trynod.si with your own USDC.

1. **Connect.** In claude.ai: Settings → Connectors → Add custom connector, name `Nod`, URL
   `https://testnet.trynod.si/mcp`, leave the OAuth client fields empty, then Connect. In Claude Code:
   `claude mcp add --transport http -s user nod https://testnet.trynod.si/mcp`, then `/mcp` → nod → Authenticate.
2. **Create your wallet and set one number.** The consent page opens: create a passkey wallet, set Claude's allowance
   (5 USDC until tomorrow 12:00 UTC) and approve with your passkey.
3. **Ask Claude**, and watch the allowance:
   - "Show my Nod wallet overview": 10 USDC in the wallet, 5.00 Claude may spend.
   - "Buy the market brief at https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief": 0.10 USDC over
     x402, no prompt. 4.90 left.
   - "Send Alice 2 USDC": paid on its own. 2.90 left.
   - "Pay Bob 5 USDC for dinner": more than what is left, so it needs your nod. Claude returns a link; open it, check
     Bob and 5 USDC, approve with your passkey. The allowance stays 2.90.
   - "Retry that same dinner payment using the same idempotency key": the same receipt; Bob is paid once.
   - "Send Alice 4 USDC": needs your nod; nothing is reserved. Leave it.
   - "Send Carol 1 USDC": Carol has never held USDC, so after your nod she gets a claim link (on the sandbox, accept it
     with the demo button); her trustline and the payment land in one transaction.
4. **Revoke** Claude on the site under Connections, then remove its rule with your passkey. The pocket comes back to
   your wallet, and Claude's next payment is refused.

Expected results for every step: [evidence/JUDGE-TEST-PATH.md](evidence/JUDGE-TEST-PATH.md).

**No Claude at hand?** [testnet.trynod.si/sample](https://testnet.trynod.si/sample) runs a sample agent through the same
tool handlers Claude calls over MCP, on Nod's own demo wallet (held by a software passkey on the service), with a live
log of amounts, nods, fees and stellar.expert links. It shows Nod working; it is not your wallet.

## Architecture

```
Claude, ChatGPT, Goblin, Claude Code (any MCP app)
   │  MCP over OAuth 2.1 (PKCE; CIMD or dynamic registration); two lanes: 2025 protocol and 2026-07-28
   │  tools · cards (ui://nod/card/v1, ui://nod/home/v1) · events (webhook or poll)
   ▼
Nod Worker on Cloudflare      /mcp · /authorize · /approve/:id · /claim/:id · /api · static site
   ├─ D1: wallets, allowances, contacts, payments, receipts, events, deposit addresses
   ├─ Durable Object per wallet: reservations, idempotency, one submit at a time, chain watcher, deposit sweeps
   ├─ signer boundary: relayer keys, per-app keys encrypted with AES-GCM
   └─ x402 client ──▶ x402.org or OpenZeppelin Channels (public facilitators)
   │  Soroban RPC
   ▼
Stellar mainnet (trynod.si) and testnet (testnet.trynod.si)
   ├─ your smart account (OpenZeppelin): rule 0 = your passkey; one rule per AI app = its key + spending limit + expiry
   ├─ USDC through the Stellar Asset Contract
   ├─ one small pocket account per AI app (sponsored reserves) for x402
   ├─ trust-and-pay router (CAP-73) for claim links
   └─ deposit router for exchange deposit addresses (testnet only)
Browser (Foldkit site): passkey sign-in, Home, Connections, Contacts, Receipts, approval and claim pages
```

**A payment inside the allowance:** the Durable Object reserves the amount → the Worker builds a USDC `transfer` from
your account → simulates it → the app's key signs its auth entry → re-simulates in enforcing mode (over-limit fails
here, before anything reaches the chain) → the relayer signs and submits → a receipt is returned after confirmation.
**A payment that needs your nod:** the intent is frozen → the approval page shows recipient name and address, amount,
fee ceiling and which app asked → your passkey signs a WebAuthn challenge bound to that auth payload → submitted by the
relayer; the allowance is untouched. **x402:** request → HTTP 402 → validate network, asset, price, payee → pull
`min(remaining, max(shortfall, 1 USDC))` into the pocket under the policy → the stock `@x402/stellar` client pays →
retry → content and both hashes on the receipt.

How Stellar is used:

| Stellar piece                                | Role in Nod                                                  | Testnet                                                                                                                                                                                                                                                                                                                                                                                | Mainnet                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenZeppelin smart account (Soroban)         | one contract account per wallet, deployed by the relayer     | WASM `1b5f4534…785a`                                                                                                                                                                                                                                                                                                                                                                   | same WASM                                                                                                                                                                                                                                              |
| OpenZeppelin spending-limit policy           | the allowance: N USDC until T, per AI app                    | [`CABXBYJN…IP5G`](https://stellar.expert/explorer/testnet/contract/CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G)                                                                                                                                                                                                                                                           | [`CBCGTERZ…YUS4`](https://stellar.expert/explorer/public/contract/CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4)                                                                                                                            |
| WebAuthn verifier (secp256r1 host function)  | your passkey: admin, approvals, allowance changes            | [`CC7EKIHQ…OM3F`](https://stellar.expert/explorer/testnet/contract/CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F)                                                                                                                                                                                                                                                           | [`CB7HENHJ…Q5YR`](https://stellar.expert/explorer/public/contract/CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR)                                                                                                                            |
| Ed25519 verifier                             | each AI app's own key                                        | [`CAAVTMCB…HKN4`](https://stellar.expert/explorer/testnet/contract/CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4)                                                                                                                                                                                                                                                           | [`CBOOZV2B…UEMC`](https://stellar.expert/explorer/public/contract/CBOOZV2BK5OETGL4Q4KGEBESPRLJFN7DOFWDT7OZGLD7EQEZUVOWUEMC)                                                                                                                            |
| Circle USDC, Stellar Asset Contract (SEP-41) | the money (7 decimals)                                       | [`CBIELTK6…DAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA)                                                                                                                                                                                                                                                           | [`CCW67TSZ…MI75`](https://stellar.expert/explorer/public/contract/CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75)                                                                                                                            |
| SAC `trust` (CAP-73) + our router            | claim link: trustline and transfer in one invocation         | [`CCLFB4I4…PGN4`](https://stellar.expert/explorer/testnet/contract/CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4)                                                                                                                                                                                                                                                           | [`CBWYFI6X…T6TM`](https://stellar.expert/explorer/public/contract/CBWYFI6XWQI5C43GISIIUFXTJXBUI52QSNKKYC55GWMPLQRL2RAXT6TM)                                                                                                                            |
| SAC `approve` + our deposit router           | deposit addresses: a bound `G…` swept into the wallet        | [`CAFLFU5G…OXGL`](https://stellar.expert/explorer/testnet/contract/CAFLFU5GH7QZ6KF3FBKRV7VW5XFYUKQPCFFTCPTKVEUG4TDT5B2ZOXGL)                                                                                                                                                                                                                                                           | not deployed                                                                                                                                                                                                                                           |
| Soroban authorization                        | per-signer auth entries, enforcing re-simulation             |                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                                                                                                                        |
| Sponsored reserves                           | pocket and deposit accounts hold 0 XLM of their own          |                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                                                                                                                        |
| Relayer pool as transaction source           | Nod pays every fee; owners hold no XLM                       | [`GBCALSA3…YWBR`](https://stellar.expert/explorer/testnet/account/GBCALSA3XQAWW24AXGFWJIGNUCDBCMUPPWC5XHMZ22VY4HMX6XCFYWBR), [`GAWYWVMH…YSE4I`](https://stellar.expert/explorer/testnet/account/GAWYWVMHLTRN6N7DXKV3XYCLAFPCPPUXPDFC7J5KL3LNKO26YNJSYE4I), [`GBGNYETY…BPT6`](https://stellar.expert/explorer/testnet/account/GBGNYETYEEWM5RIRE6KWUUZKD3X4DBZZ72M2LHQJNUGYO3D6ZYADBPT6) | [`GBVYA2V4…YG5X`](https://stellar.expert/explorer/public/account/GBVYA2V4SMVPXFRPVB5FEFCADW7RXFIACR2HBLN2WP3RHAZKL267YG5X), [`GDMYACRM…CAGP`](https://stellar.expert/explorer/public/account/GDMYACRM646Z4QIUPIAQZ2W3HSKAO2LESWCME73RSCCETSQKSL6HCAGP) |
| x402                                         | paid APIs through public facilitators                        | `stellar:testnet`: x402.org, OpenZeppelin Channels                                                                                                                                                                                                                                                                                                                                     | `stellar:pubnet`: OpenZeppelin Channels                                                                                                                                                                                                                |
| SEP-1 `stellar.toml`, `home_domain`          | the service's accounts name trynod.si                        | `/.well-known/stellar.toml`                                                                                                                                                                                                                                                                                                                                                            | `/.well-known/stellar.toml`                                                                                                                                                                                                                            |
| Built-in DEX                                 | the demo seller's market brief reads the XLM/USDC order book |                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                                                                                                                        |

The routers are our two product contracts. `stellar contract build` in `contracts/` (stellar-cli 28.1.0, rustc 1.98.1,
`wasm32v1-none`, the workspace release profile) reproduces the trust-and-pay router's deployed WASM byte for byte
(sha256 `39c97734…`, 920 bytes), so
[`CCLFB4I4…PGN4`](https://stellar.expert/explorer/testnet/contract/CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4)
and its mainnet twin
[`CBWYFI6X…T6TM`](https://stellar.expert/explorer/public/contract/CBWYFI6XWQI5C43GISIIUFXTJXBUI52QSNKKYC55GWMPLQRL2RAXT6TM)
are provably this source (records in [`contracts/deployments/`](contracts/deployments/)). The deposit router
(`contracts/deposit`, wasm `7bc3752b…`) is on testnet only.

Deployed:

| What                         | Mainnet                                                                    | Testnet                                                            |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Site and wallet service      | https://trynod.si                                                          | https://testnet.trynod.si                                          |
| MCP connector                | `https://trynod.si/mcp`                                                    | `https://testnet.trynod.si/mcp`                                    |
| Demo x402 seller (0.10 USDC) | https://hm26-seller-mainnet.kristjan-grm11775.workers.dev/api/market-brief | https://hm26-seller.kristjan-grm11775.workers.dev/api/market-brief |
| Machine-readable summary     | https://trynod.si/llms.txt                                                 | https://testnet.trynod.si/llms.txt                                 |
| Health and release           | https://trynod.si/api/health                                               | https://testnet.trynod.si/api/health                               |

Software: one TypeScript program from the browser to the edge. **[Foldkit](https://foldkit.dev)** (Elm architecture on
Effect) for the site and the MCP Apps cards; **[Effect](https://effect.website) 4** for the Worker, with an `HttpApi`
contract in `packages/api` shared by browser and Worker; **[Alchemy](https://alchemy.run)** declares the Worker, D1 and
Durable Objects in `apps/web/alchemy.run.ts` (stages `local`, `testnet` and `mainnet`); `packages/stellar` talks to
Stellar through `@stellar/stellar-sdk` 16.4.1; the routers are Rust on soroban-sdk 29 in [`contracts/`](contracts).

## Setup and installation

Requirements: Bun 1.4.2, Node 24, Rust with the `wasm32v1-none` target, and
[stellar-cli](https://github.com/stellar/stellar-cli) 28.1.

```sh
bun install
bun run dev            # http://localhost:18960: the app and its API under local workerd
bun run smoke:local    # HTTP acceptance of the running stage
bun run shots          # phone and desktop screenshots in .local/shots/
bun run check          # format, skills/MCP drift, cards, lint, typecheck (TypeScript + Effect diagnostics), tests,
                       # contract lint and tests, build
```

Without any secrets the Worker runs on an in-memory fixture chain (`CHAIN=fixture`, the default). To use the real chain,
set `CHAIN=stellar` and the secrets below in `apps/web/.env.<stage>`; `scripts/stage.ts` binds them as Worker secrets.
`bun run deploy:testnet` deploys the `testnet` stage; `bun scripts/stage.ts deploy:mainnet` the `mainnet` stage.

Contracts:

```sh
bun run contracts:test       # unit tests (soroban testutils)
bun run contracts:build      # stellar contract build
bun run contracts:deploy     # build and deploy to testnet; records the id in contracts/deployments/testnet.json
bun run contracts:bindings   # regenerate packages/counter-client from the wasm
```

## Environment variables

Secrets are bound as Worker secrets and never committed. Everything else is plain and has a default.

| Name                                                                                                                  | Default                            | Meaning                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CHAIN`                                                                                                               | `fixture`                          | `fixture` = in-memory chain; `stellar` = the real chain on `STELLAR_NETWORK`                                     |
| `STELLAR_NETWORK`                                                                                                     | `testnet`                          | `testnet` or `pubnet` preset (contract ids, RPC, passphrase, facilitators, fee ceilings)                         |
| `ORIGIN` · `RP_ID`                                                                                                    | request origin · request host      | public URL (OAuth issuer, links, passkey origin) and passkey relying-party id                                    |
| `RELAYER_SECRET` or `RELAYER_SECRETS` (secret)                                                                        | none                               | fee-paying source account(s); required on the real chain                                                         |
| `VAULT_KEY` (secret)                                                                                                  | none                               | AES-GCM key that encrypts each AI app's key; required                                                            |
| `TREASURY_SECRET` (secret)                                                                                            | none                               | funds new testnet wallets with welcome USDC                                                                      |
| `OZ_FACILITATOR_KEY` / `OZ_CHANNELS_API_KEY` (secret)                                                                 | none                               | OpenZeppelin Channels (the facilitator on mainnet, the fallback on testnet)                                      |
| `PAYMENTS_ENABLED`                                                                                                    | `true`                             | kill switch; revoke and sweep still work                                                                         |
| `WALLET_CREATE_PER_VISITOR_HOUR` · `WALLET_CREATE_PER_HOUR`                                                           | `3` · `30`                         | wallets created per visitor (hashed IP) and in all, per hour; the testnet stage runs 20 · 200                    |
| `INVITE_REQUIRED` · `INVITE_CODES` (secret)                                                                           | network decides · empty            | invite-only signup; both live stages run with `INVITE_REQUIRED=false`                                            |
| `WELCOME_USDC_STROOPS`                                                                                                | `100000000` (10 USDC)              | welcome USDC for a new wallet, testnet only                                                                      |
| `SAMPLE_ENABLED`                                                                                                      | `true`; `false` on mainnet         | the `/sample` agent (testnet only)                                                                               |
| `DEMO_CONTACTS` · `DEMO_RECIPIENT_SECRET` (secret) · `DEMO_CLAIM_SIGNER`                                              | `seeds.json` · none · testnet only | Nod's demo contacts, the key that accepts the demo Carol's claim link, and whether that key may sign off testnet |
| `MAX_FEE_STROOPS` · `FIRST_PULL_MAX_FEE_STROOPS` · `PULL_MAX_FEE_STROOPS` · `OWNER_MAX_FEE_STROOPS`                   | the preset                         | fee ceilings the relayer will pay                                                                                |
| `X402_FACILITATOR_URL` · `X402_FALLBACK_FACILITATOR_URL`                                                              | the preset                         | facilitators (testnet: x402.org, then OpenZeppelin Channels; mainnet: OpenZeppelin Channels)                     |
| `ONBOARD_ROUTER_ID` · `DEPOSIT_ROUTER_ID`                                                                             | the preset                         | the two routers; required on pubnet for claims; `DEPOSIT_ROUTER_ID=off` disables deposits                        |
| `OWNER_AUTH_LEDGERS` · `WALLET_TTL_LEDGERS`                                                                           | `400` · `518400`                   | approval validity and wallet state lifetime, in ledgers                                                          |
| `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, contract id overrides (`USDC_SAC_ID`, `SPENDING_LIMIT_POLICY_ID`, …) | the preset                         | overrides for another network                                                                                    |

The allowance is the only spending limit. `MAX_GRANT_USDC`, `MAX_OWNER_PAYMENT_USDC` and `MAX_X402_PRICE_USDC` remain
as input bounds in the code and are set to 1,000,000 on both live stages.

Bindings (not variables): `WALLET_DB` (D1), `WALLET_OBJECT`, `OAUTH_STORE` and `SAMPLE_RUNNER` (Durable Objects),
`ASSETS`.

## Repository

| Path                | What                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/web`          | Foldkit site and MCP Apps cards, Cloudflare Worker (OAuth, MCP tools and events, pages), Alchemy stack               |
| `apps/seller`       | the demo x402 seller Worker (HTTP and a paid MCP tool)                                                               |
| `packages/stellar`  | the Stellar chain package: accounts, allowances, payments, pocket, x402, claim, deposits                             |
| `packages/protocol` | tool and entity schemas shared by the service and the chain package                                                  |
| `packages/api`      | the HTTP API contract (Effect Schema) shared by browser and Worker                                                   |
| `contracts`         | Soroban workspace: the trust-and-pay router (`onboard`), the deposit router, a toolchain counter, deployment records |
| `scripts`           | stage runner, smoke and screenshot checks, rehearsal runner, mainnet scripts                                         |
| `docs`, `spikes`    | product spec, pitch, research and the spikes that de-risked it                                                       |
| `evidence`          | mainnet and testnet runs, host screenshots, settlements and the judge test path                                      |

## Prior work

Everything in this repository was written during HackMeridian; the commit history starts on 25 October 2026. Used as-is
from others: OpenZeppelin's deployed Stellar smart-account, verifier and spending-limit contracts; Circle's USDC; the
x402 libraries and the hosted facilitators x402.org and OpenZeppelin Channels; agent skills vendored with source, commit
and licence in `.agents/skills/sources.json`. Repository conventions and agent tooling come from Kristjan's earlier
projects. The MCP Events wire (schemas, webhooks, delivery, journal, policy) was ported from Kristjan's own myapps
codebase and the 2026-07-28 MCP lane is modelled on his agent-jobs server; Goblin, one of the three hosts shown, is
Kristjan's own MCP host. Kristjan built Froggy at ETHOnline 2026, an agent wallet on Base and Hedera whose limits were
enforced by its own server; no Froggy code is used here, and Nod moves the limit onto the account itself.

## Built with AI

Nod was written by Kristjan with Claude Code: parallel Claude Opus 5.5 and Fable sessions for the spec, the spikes, the
build streams and the copy, working on one shared `main` under the rules in [AGENTS.md](AGENTS.md). Raven, Stellar's MCP
server, and Stellar's developer skills supplied documentation and ecosystem research. Gemini in the Antigravity CLI
reviewed the copy. Every onchain claim above was run on Stellar and links to stellar.expert.

MIT licensed.
