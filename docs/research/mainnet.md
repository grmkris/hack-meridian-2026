# Mainnet readiness (spike S7)

Historical readiness study before the mainnet release. For later execution evidence, see
[MAINNET.md](../MAINNET.md). The costs and proposed launch conditions below describe this study only.

Status: done 2026-10-25 12:41–13:15 UTC. **Read-only**: nothing was signed, sent or spent, and no secret of ours was
used. Mainnet numbers come from RPC reads and **unsigned simulations** (public funded accounts as source); S1/S3/S5
testnet transactions were re-read and their ledger-entry changes re-priced at mainnet parameters. Scratch scripts (not
committed): `/tmp/s7/scripts/{config,anatomy,sim,ttl,extend,trust}.ts`. **UNVERIFIED** = not checked first-hand.

**Headline.** Everything we use on testnet already exists on mainnet with byte-identical WASM, except our 920-byte
onboarding router. Mainnet rent sits at the **1,000 stroops/KB floor** (state at 55 % of target) against 660,521 on
testnet today, so the lifecycle that costs ~55 XLM on testnet costs **~0.6 XLM** on mainnet. OpenZeppelin Channels
settles `stellar:pubnet` for free with sponsored fees. What remains is our work: a stage, caps, a kill switch, funding.

## (a) Config: testnet vs mainnet

| Setting                                | Testnet (today)                                                                                          | Mainnet (pubnet)                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Network passphrase                     | `Test SDF Network ; September 2015`                                                                      | `Public Global Stellar Network ; September 2015` (`getNetwork`, Horizon `/`)                                     |
| x402 / CAIP-2 network                  | `stellar:testnet`                                                                                        | `stellar:pubnet`                                                                                                 |
| Soroban RPC                            | `https://soroban-testnet.stellar.org` (SDF)                                                              | **no SDF endpoint**: `https://mainnet.sorobanrpc.com`, fallback `https://soroban-rpc.mainnet.stellar.gateway.fm` |
| Horizon                                | `https://horizon-testnet.stellar.org`                                                                    | `https://horizon.stellar.org`                                                                                    |
| Friendbot                              | `https://friendbot.stellar.org`                                                                          | **none** (`friendbotUrl: null`); XLM and USDC are bought                                                         |
| Explorer                               | `https://stellar.expert/explorer/testnet`                                                                | `https://stellar.expert/explorer/public`                                                                         |
| Account WASM hash                      | `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`                                       | **same hash, already uploaded** (fetched: 41,855 B, byte-identical)                                              |
| Ed25519 verifier                       | `CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4`                                               | `CBOOZV2BK5OETGL4Q4KGEBESPRLJFN7DOFWDT7OZGLD7EQEZUVOWUEMC`                                                       |
| WebAuthn (secp256r1) verifier          | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F`                                               | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR`                                                       |
| Spending-limit policy                  | `CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G`                                               | `CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4`                                                       |
| USDC issuer                            | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`                                               | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`                                                       |
| USDC SAC                               | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`                                               | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` (`decimals()` = 7)                                    |
| XLM SAC                                | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`                                               | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`                                                       |
| Onboard router (S3)                    | `CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4`                                               | **not on mainnet**: upload WASM `39c97734…3888` and deploy (≈ 2.5 XLM)                                           |
| x402 facilitator                       | x402.org, fallback OZ Channels testnet                                                                   | **OZ Channels `https://channels.openzeppelin.com/x402`** (Bearer key, mainnet-scoped); fallback Vellar           |
| USDC source                            | SDEX buy with friendbot XLM                                                                              | SDEX buy with real XLM, or an exchange withdrawal (Stellar USDC support per exchange UNVERIFIED)                 |
| Rent write fee                         | **660,521** stroops/KB (state 100.48 % of 4 GB target)                                                   | **1,000** stroops/KB, the floor (state 1.65 GB = 55.1 % of 3 GB target)                                          |
| `minPersistentTtl` / `minTemporaryTtl` | 120,960 (7 d) / 720                                                                                      | **2,073,600 (120 d)** / 17,280 (1 d)                                                                             |
| Soroban inclusion fee                  | 100                                                                                                      | p10–p99 **200** stroops over 50 ledgers (`getFeeStats`); bid 10,000 for headroom                                 |
| Fee ceilings (`PUBNET.fees`)           | max 40 / first pull 35 / pull 4 / owner 12 XLM                                                           | the prepared 2 / 1 / 0.2 / 0.2 XLM are ≥ 10× the estimates in (c): keep them                                     |
| Judge auto-fund / relayer alert        | 10 USDC / 500 XLM                                                                                        | **off** / 10 XLM                                                                                                 |
| Unchanged                              | protocol 29; CPU, IO, write and size fee config; base reserve 0.5 XLM; ledger 5.0 s; `maxEntryTtl` 180 d | same (read from both networks)                                                                                   |

`packages/stellar/src/network.ts` already has a `PUBNET` preset with empty contract ids and `rpcUrl: ''`; the right
column is what goes into it. `apps/seller/src/config.ts`'s pubnet SAC `CCW67TSZ…MI75` matches the derived id and
`@x402/stellar` 2.28.0's `USDC_PUBNET_ADDRESS`. The stock client **throws on `stellar:pubnet` without an `rpcUrl`**;
`packages/stellar/src/x402.ts` already passes one.

## (b) Findings

### Q1. OpenZeppelin smart-account stack on mainnet: yes, already deployed

Source: https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md. It records
the same OZ build (`stellar-contracts@1e513890`, soroban-sdk 26.1.0) "rehearsed on testnet, and deployed to mainnet" from
`GAAH4OT3…WQ4N` (uploads cost 90.68 XLM). Verified today on mainnet with stellar-cli 28.1.0: `contract fetch` by id
and by WASM hash, `sha256sum`, and `contract info interface` diffed against the testnet contract.

| Role                  | Mainnet id                                                 | WASM (mainnet = testnet) | Interface vs testnet  | Instance / WASM live until (≈ UTC)       |
| --------------------- | ---------------------------------------------------------- | ------------------------ | --------------------- | ---------------------------------------- |
| Smart account WASM    | per wallet (upload tx `c6c7461f…`)                         | `1b5f4534…`, 41,855 B    | bytes identical       | WASM 66,824,189 (2027-01-31)             |
| WebAuthn verifier     | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` | `e63a030d…`              | identical (34 lines)  | 66,824,189 both (2027-01-31)             |
| Ed25519 verifier      | `CBOOZV2BK5OETGL4Q4KGEBESPRLJFN7DOFWDT7OZGLD7EQEZUVOWUEMC` | `60e8798d…`              | identical (20 lines)  | 66,824,189 both (2027-01-31)             |
| Spending-limit policy | `CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4` | `e41b563c…`              | identical (158 lines) | **65,479,880 / 65,479,867 (2026-11-14)** |
| USDC SAC              | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | built-in                 | —                     | 67,326,585 (2027-03-01)                  |

- Same bytes mean the same `__check_auth`, **v0.7.x legacy-concat digest** and error codes: the signer code needs only
  new ids and the passphrase. **Deploy wallets with our relayer as deployer** (`createCustomContract`, as S1 did); SAK's
  shared deployer `GAAH4OT3…` is public by design (0.00199 XLM) and its `docs/mainnet-hardening.md` says "Never fund".
- **TTL.** New persistent entries on mainnet start at 120 days, so our wallets, rules and router outlive the hackathon
  with no extension. The shared policy expires ≈ 14 Nov 2026 (after judging). Simulated `ExtendFootprintTTL` on its
  instance + WASM: **11.79 XLM to +120 d, 18.88 XLM to the 180-day maximum**; anyone can pay it.
- **Onboarding router**: `stellar contract fetch --wasm-hash 39c97734… --network testnet` works (920 B, hash matches);
  mainnet says `Contract Code not found`. Simulated mainnet `uploadContractWasm`: `minResourceFee` **24,893,934
  (2.49 XLM)** (code is rented on its parsed-module size). Deploy, re-priced from testnet `634bcf18`: **≈ 0.016 XLM**.
- **CAP-73 `trust` exists on the mainnet USDC SAC**: simulated `USDC.trust(G…)` for an XLM-only account → OK
  (`minResourceFee` 124,307, one auth entry); for a dust account → `Error(Contract, #14)`, as in S3. The claim link
  works unchanged; Carol still needs ≥ 1.5 XLM.

### Q2. x402 facilitators on pubnet

Probes 2026-10-25 ~13:00 UTC, one sample each (not an uptime measurement):

| Facilitator                                                   | `/supported`                                                                                                                                                                                                                                                                                                      | Usable by our pocket (stock client needs `areFeesSponsored: true`) |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| x402.org `https://www.x402.org/facilitator`                   | 200, 0.26 s. Stellar kind is `stellar:testnet` only; signers `GC6CSXBV…`, `GC5OLUZ4…`                                                                                                                                                                                                                             | **no** (no pubnet)                                                 |
| **OZ Channels `https://channels.openzeppelin.com/x402`**      | no key → 401 `{"success":false,"code":401,"error":"Unauthorized"}`. With a key from `/gen` → 200, 0.42 s: `{"kinds":[{"extra":{"areFeesSponsored":true},"network":"stellar:pubnet","scheme":"exact","x402Version":2}],"signers":{"stellar:pubnet":["GA5SXMFJTUPTZRIEKM6XZLCYOZRMUEE6KGAHL3GXDBG64DYOUIWYIF3M"]}}` | **yes**                                                            |
| Vellar `https://vellar-facilitator-production.up.railway.app` | 200, 0.35 s, no key, `x-ratelimit-limit: 60`: `exact` and `upto` on `stellar:pubnet`, `areFeesSponsored: true`, 6 signers                                                                                                                                                                                         | yes, with caveats                                                  |
| Ultravioleta DAO `https://facilitator.ultravioletadao.xyz`    | 200: `stellar:pubnet` with `extra.feePayer`, no `areFeesSponsored`                                                                                                                                                                                                                                                | **no** (our client throws)                                         |
| CDP, PayAI, x402.rs, Mogami, others                           | no Stellar (CDP 401; its docs list EVM and Solana)                                                                                                                                                                                                                                                                | no                                                                 |

- **OZ Channels mainnet.** Stellar's docs (https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar):
  "Free, public x402 facilitator for Stellar with ~5-second finality and sponsored fees"; keys from
  `https://channels.openzeppelin.com/gen` "(requires GitHub OAuth)". In fact a plain `GET /gen` minted a mainnet key
  (201) with no login; it is rejected on `/x402/testnet/supported` (keys are network-scoped). It was used once for
  `/supported` and not stored: **mint your own**. The OZ guide (https://docs.openzeppelin.com/relayer/guides/stellar-channels-guide):
  "Free to Use … (subject to fair use policy)", "Each API key has a fee consumption limit (measured in stroops)",
  reset 24 h after the first transaction, then `FEE_LIMIT_EXCEEDED`; busy pool → `POOL_CAPACITY`. The hosted limit and
  `maxTransactionFeeStroops` are UNVERIFIED (self-host example: `FEE_LIMIT=1000000` ≈ 45 of our 22k-stroop
  settlements a day). Our payer is a plain `G…`, so the event scan and fee cap that block smart-account payers (#3352,
  #3515) do not apply. Signer `GA5SXMFJ…` held 10,093.99 XLM and was active today. No audit published.
- **Vellar** (https://docs.vellar.xyz/docs/facilitator): community-run, self-reviewed; README reports "11 x402
  settlements confirmed on mainnet (Sept 17-21, 2026)" (team-funded) yet elsewhere "there is no pubnet deployment";
  sponsor `GBB7PVDR…` held 39.06 XLM; **binds a resource URL to the first `payTo` that settles for it**.
- **Public mainnet sellers exist**: `https://stellar.org/x402-demo/api/protected/mainnet` → 402, `stellar:pubnet`,
  `amount "100000"` (0.01 USDC), asset `CCW67TSZ…`, `payTo GCGUB2W3…5SAR`, `areFeesSponsored: true` (`/pubnet` → 404).
  Paying it is a cheap "third-party seller on mainnet" moment. Vellar's seller demo charges 0.10 USDC.
- **Recommendation: the demo seller uses OZ Channels mainnet** (`FACILITATOR=oz`, `OZ_FACILITATOR_URL=…/x402`,
  `OZ_FACILITATOR_KEY` as a Worker secret), Vellar as keyless fallback: the path S5 proved on testnet (`4ddef672`).

### Q3. Mainnet RPC and Horizon

SDF runs **no public mainnet Soroban RPC** (stellar-cli: "Bring Your Own"; https://developers.stellar.org/docs/data/apis/rpc/providers
lists third parties). Probes 12:45–12:52 UTC: single calls, 25 parallel `getLatestLedger`, and a session of
`getAccount` + 3 simulations + `getFeeStats`. "doc" = the provider's published limit.

| Endpoint                                           | Probes                                                                                                | Free-tier limit                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `https://mainnet.sorobanrpc.com` (overcat)         | 200, RPC 29.0.0, Cloudflare; 25 × 200, p50 1.66 s; session 1.17 s                                     | doc: "Free to use, no registration required … 60 requests per 10 seconds"                      |
| `https://soroban-rpc.mainnet.stellar.gateway.fm`   | 200, RPC 29.0.1; 25 × 200, p50 0.54 s; session **0.72 s**                                             | none published; headers `x-ratelimit-remaining-ip: 26…29`, `-global: ~950` (window UNVERIFIED) |
| `https://rpc.lightsail.network/` (Quasar, overcat) | 200, RPC 29.0.0, Cloudflare; 25 × 200, p50 1.02 s; session 1.01 s                                     | doc: "Rate limits apply"; no number (UNVERIFIED)                                               |
| `https://rpc.ankr.com/stellar_soroban`             | 200, RPC 30.0.0; **25 parallel: 10 × 200, 15 × 429**; 35 sequential: no 429                           | 30 req/s per a third-party summary (UNVERIFIED); concurrency is the binding limit              |
| `https://stellar.api.onfinality.io/public`         | 200, then **429** "Please apply an OnFinality API key"                                                | headers: 1 req/s, 60 per minute: unusable                                                      |
| Nodies / Liquify (public URLs from the docs page)  | Nodies 404 `Unsupported path: /` ("Network not active" on other paths); Liquify 404 `Chain not found` | no working keyless path                                                                        |
| Validation Cloud / QuickNode / Blockdaemon (keyed) | Validation Cloud 401 without key                                                                      | doc: 50M CU/month free / 30-day trial at 15 req/s / 3M CU/month at 5 RPS                       |

All healthy endpoints were on the same ledger with 7 days of history. **Recommendation: primary
`https://mainnet.sorobanrpc.com`** (published limit; the default in `stellar/x402-stellar`'s `.env.example`),
**fallback `https://soroban-rpc.mainnet.stellar.gateway.fm`** (other operator, fastest here); not Lightsail (same
operator as sorobanrpc.com). Workers share egress IPs, so retry on 429 and fail over. **Horizon**
`https://horizon.stellar.org` → 200, v30.0.0, no rate-limit headers (Horizon default 3,600/h per IP; one year of history).

### Q4. USDC on mainnet

`stellar contract id asset --network mainnet --asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` →
**`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`**. Simulated reads: `decimals()` = **7**, `name()` =
`"USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"`, `symbol()` = `"USDC"`. Every amount in the code is
unchanged. A simulated first 1 USDC `transfer` into a fresh `C…`, which creates its balance entry, costs 0.044 XLM.

### Q5. Mainnet rent and what it does to our costs

Read with `getLedgerEntries` on the `ConfigSetting` keys (`/tmp/s7/cfg-main.json`, `cfg-test.json`).
`sorobanStateTargetSizeBytes` is **3.0 GB** (testnet 4.0); the live window averages **1,653,256,388 B = 55.1 %**, so
27,000 × 0.551 − 17,000 < 0 and the **1,000 stroops/KB floor** applies. Testnet: 660,521 (S1 measured 473,038, S5
525,447). **Mainnet rent is ~660× cheaper than testnet now** and 1.35 GB of growth away from moving at all.
Mainnet's `minPersistentTtl` is **120 days** (testnet 7): new entries prepay 120 days (1,667 stroops/byte), and the OZ
contracts' "extend to 30 days" calls are no-ops for months, so **the first payment under a grant costs the same as any
other** (no 12–17 XLM TTL bump).

**Method.** Per S1/S3/S5 transaction: keep the measured non-refundable part (identical CPU/IO/write/size config) and
re-price the rent of its ledger-entry changes as mainnet charges it (new entries at 120 d, growth at 120 d remaining,
no TTL bumps). Checked against **mainnet simulations**: deploy 0.154 vs 0.184 declared (≈ 1.15× the charge), first
USDC into a new `C…` 0.037 vs 0.044; the router upload (0.17 vs **2.49**) shows the method misses code rent, so that
row uses the simulation.

## (c) Cost table

XLM charged per operation; testnet measured in S1/S3/S5, mainnet estimated as above (declared fee ≈ 15 % higher).

| Operation (payer)                                                | Testnet measured     | Mainnet estimate                                   |
| ---------------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| deploy smart account, passkey rule 0 (relayer)                   | 3.89–4.12            | **0.15** (simulated, declared 0.184)               |
| first USDC into a new wallet (treasury)                          | 4.17                 | **0.04** (simulated, declared 0.044)               |
| grant install: the wallet's first rule (relayer; passkey signs)  | 6.15–13.84           | **0.23**                                           |
| grant install: later rule or renewal                             | 2.91–2.97            | **0.11**                                           |
| first delegated payment or pocket pull under a rule              | 12.26–17.24          | **0.015**                                          |
| further delegated payment or pocket pull (+80 B history)         | 1.49–1.69            | **0.015**                                          |
| owner (passkey) payment, including a wallet's first passkey auth | 0.0022 (first: 8.45) | **0.0012**                                         |
| rule removal (revoke) / sweep pocket → wallet                    | 0.0025 / 0.0022      | **0.0014 / 0.0010**                                |
| pocket create / close (classic, sponsored)                       | 0.00004 / 0.00002    | 0.0003 / 0.0002, and **1.5 XLM locked** while open |
| x402 settlement from the pocket (the facilitator pays)           | 0.0023               | 0.0011, not ours                                   |
| claim link: router `trust` + `transfer` (relayer)                | 0.0037               | 0.0017; the recipient holds ≥ 1.5 XLM              |
| one-off: router upload + deploy                                  | 52.48 + 0.42         | **2.49 + 0.016** (upload simulated)                |

**Per connection per day** (install, pocket, 20 purchases): testnet ≈ 49 XLM (S5) → mainnet **≈ 0.53 XLM** (0.23 +
20 × 0.015) **+ 1.5 XLM locked**; ≈ 0.26 with 1-USDC chunks. **Per demo run** (deploy, fund, install, pocket, x402
pull, Alice, Bob by passkey, revoke, sweep, close, Carol claim): **≈ 0.6 XLM** + 1.5 XLM locked during the run.
**USDC per run**: nothing is burned (seller, Alice, Bob, Carol are ours), but the wallet needs working capital:
**≈ 115 USDC** for the SPEC script (0.10 + 2 + 100 + 10; SPEC step 3's "balance 50" cannot cover step 6's 100), or
**≈ 20 USDC** for a small-amounts script (grant 5, x402 0.10, Alice 1, Bob 10 by passkey, Carol 1). **Funding:**

| Account to fund                                         | XLM              | USDC            | Why                                                                                   |
| ------------------------------------------------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------- |
| relayer 1 (source, fee payer, deployer, pocket sponsor) | 25               | 0               | 1 minimum + 2.5 router + 1.5 per open pocket + 0.6 × 10 rehearsals, then × 1.5 margin |
| relayer 2 (parallel sequence)                           | 10               | 0               | S1: one `G…` serializes on its sequence number                                        |
| treasury (funds the demo wallet)                        | 3                | 25              | 1 minimum + 0.5 trustline + fees; 115 USDC for the full script                        |
| seller `payTo`, Bob (USDC ready)                        | 2 + 2            | 0               | 1 minimum + 0.5 USDC trustline each                                                   |
| Carol (no trustline)                                    | 2                | 0               | ≥ 1.5 so the claim's `trust` succeeds (S3 floor)                                      |
| **Total**                                               | **44 (fund 50)** | **25 (or 115)** | Alice is a smart account relayer 1 deploys; the owner wallet holds no XLM             |

## (d) Go-to-mainnet checklist and recommendation

**Accounts**: relayer 1 (also sponsors pockets) and 2, treasury, seller `payTo`, Bob, Carol, Alice (smart account).
Keys generated locally, secrets straight into the stage's Alchemy secrets, never in printed `.env` files or
`evidence/`; USDC bought on the SDEX (`pathPaymentStrictReceive`, as S1). **Secrets per stage** (disjoint):
`RELAYER_SECRET`(s), `TREASURY_SECRET`, `VAULT_KEY`, OAuth/session secrets, seller `OZ_FACILITATOR_KEY` (mainnet key),
optional RPC key. Separate D1 and Durable Object namespaces and a **separate hostname**, so the WebAuthn rpId differs
and a testnet passkey can never sign for a mainnet wallet. **Config values that differ**: every row of table (a).

**Safety caps** (env vars, all new code, enforced in `packages/stellar`'s signer boundary so every path is covered):

| Var                                   | Mainnet                          | Enforced where                                                                                                                |
| ------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MAX_GRANT_USDC`                      | 20                               | the consent page and `installGrant` refuse more; the onchain `spending_limit` is the backstop                                 |
| `MAX_GRANT_LIFETIME_HOURS`            | 48                               | `installGrant`                                                                                                                |
| `MAX_OWNER_PAYMENT_USDC`              | 100                              | `payment_prepare` and `prepareOwnerTransfer` (a passkey signs whatever it is shown)                                           |
| `MAX_X402_PRICE_USDC`                 | 1                                | the grant hook, plus `setSpendControls({ maxAmountPerPayment: '$1' })`                                                        |
| `PAYMENTS_DISABLED` (kill switch)     | unset; `1` = off                 | every signing path refuses (delegated, pull, owner finalize, pocket create, treasury); reads and **revoke + sweep still run** |
| `TREASURY_AUTOFUND_USDC`              | 0                                | judge auto-fund off                                                                                                           |
| `SIGNUP_ALLOWLIST`                    | Kristjan only                    | mainnet wallet creation is invite-only                                                                                        |
| fee ceilings and daily relayer budget | 2 / 1 / 0.2 / 0.2 XLM; 5 XLM/day | the existing `PUBNET.fees`, plus a daily sum that trips the kill switch                                                       |

**What is custodial.** _Not custodial:_ the owner passkey (on the device; without it the service cannot change grants,
move money outside a grant, or `upgrade` the account). _Custodial:_ the relayer keys (fee XLM), every connection key
`K` (encrypted under `VAULT_KEY`; at most its grant's remaining amount until `valid_until`), **the pocket balances
`G(K)` in full**, and the treasury. Worst case on a Worker compromise: Σ (remaining grant + pocket float) over active
grants + relayer XLM + treasury USDC, bounded by `MAX_GRANT_USDC` and invite-only signup.

**Time estimate once testnet is green: ≈ 4–5 h of agent time + ~30 min of Kristjan** (funding, facilitator key):
`PUBNET` preset + Alchemy `mainnet` stage 1 h; caps, kill switch, allowlist 1–1.5 h; accounts, SDEX USDC, router,
pubnet `seeds.json` 45 min; seller on mainnet + one real 0.10 USDC settlement 30 min; two rehearsals 45 min.

**Recommendation: CONDITIONAL yes.** Record the demo on mainnet only if all of these hold by ~06:00 UTC Monday:

1. `scripts/demo/rehearse.ts` is green end to end on testnet.
2. The seller has settled one real 0.10 USDC payment from a funded pocket through OZ Channels mainnet, and
   `/supported` shows `stellar:pubnet` with `areFeesSponsored: true` at recording time.
3. The caps and kill switch are deployed and tested: a 21 USDC grant is refused, and `PAYMENTS_DISABLED=1` blocks a
   payment but still allows revoke.
4. 50 XLM and 25 USDC are in the accounts above, and the mainnet stage is invite-only.

Otherwise record on testnet, where the product is identical. If items 3–4 hold, add a short mainnet proof: one wallet
deployed, one delegated payment and one passkey payment, with explorer links. **The judges' self-serve path stays on
testnet in every case**, because sending real USDC to strangers is a custody and abuse problem we do not need.

## (e) Risks

1. **Facilitator.** OZ Channels: unpublished per-key fee limit, fair use, `POOL_CAPACITY` under load, no SLA. Vellar:
   thinly funded (39 XLM), 60/min, URL bound on first use. Probe `/supported` before recording; keep a second key.
2. **Audit status.** The OZ build `stellar-contracts@1e513890` is 38 commits after v0.7.1, between the audited v0.7.0
   and v0.8.0 (`audits/`), built from `examples/` crates (audit scope UNVERIFIED). It lacks the GHSA-jpg9-m7w4-c7wc fix
   (medium, "Delegated signers can authorize a smart account without keys"): **never add a Delegated signer**. SAK is
   unaudited (not used at runtime). Our router, signer boundary, vault and caps are unaudited code moving real money.
3. **Shared contracts are someone else's deployment.** The verifiers and the policy expose no `upgrade` and no admin
   (`verify`/`canonicalize_key`; `enforce`/`install`/`uninstall`/`set_spending_limit`/`get_spending_limit_data`), so
   their behaviour cannot change under us. Nobody owns their TTL, though: the policy expires ≈ 14 Nov 2026 unless
   someone pays ≈ 11.8 XLM. After that every grant needs a restore first.
4. **Custody.** Pockets and connection keys make the service a partial custodian, see (d). Keep mainnet invite-only,
   the caps low, and the kill switch one secret away.
5. **RPC.** Every mainnet RPC is a third-party free tier with no SLA, and per-IP limits meet shared Worker egress. Fail
   over between operators. When polling a send, poll the provider that took it.
6. **Operational mistakes.** Wrong passphrase or testnet ids fail safe; a wrong but valid address does not. Scripts
   refuse pubnet without an explicit flag; mainnet secrets never reach `evidence/`, logs or `seeds.json`.
7. **Rent moves slowly on mainnet.** It needs 1.35 GB more state before it leaves the floor. Testnet's rent is the one
   still climbing (47× → 66× today), which makes testnet, not mainnet, the expensive stage.
