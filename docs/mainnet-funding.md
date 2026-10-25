# Mainnet funding (Track M, step M2)

Generated 2026-10-25 ~16:30 UTC by `scripts/mainnet/keys.ts` (M1). **Public keys only**: the secrets are in
`apps/web/.env.mainnet` and `scripts/demo/.env.pubnet` (gitignored, mode 600) and are never printed. Nothing has been
sent on mainnet; every spending step waits for Kristjan's go (docs/MAINNET.md).

## What to send

| Account                              | Address                                                    |    XLM |   USDC | Used for                                                                     |
| ------------------------------------ | ---------------------------------------------------------- | -----: | -----: | ---------------------------------------------------------------------------- |
| relayer A (`RELAYER_SECRET`, first)  | `GBVYA2V4SMVPXFRPVB5FEFCADW7RXFIACR2HBLN2WP3RHAZKL267YG5X` |     25 |      0 | fee payer; router upload + deploy (M3), Alice's deploy (M5), pocket reserves |
| relayer B (`RELAYER_SECRET`, second) | `GDMYACRM646Z4QIUPIAQZ2W3HSKAO2LESWCME73RSCCETSQKSL6HCAGP` |     10 |      0 | second fee payer (parallel sequence numbers)                                 |
| treasury (`TREASURY_SECRET`)         | `GBJOFDKUKPHIPG34NEMVINELO36TS3QVVLNTXRO3SRUPEK5CPMYBVSPI` |      3 |     30 | tops up the owner wallet (M7), pays the seller smoke test (M4)               |
| seller payTo (`PAY_TO`)              | `GAJ6XSMEBPLATVHRQVQK5QTL7GYGGYGHC2IFNIQZBMRNIYWHVFOAM47G` |      2 |      0 | receives x402 payments; USDC trustline                                       |
| Bob                                  | `GAVERRBSX7HTUN6EHQIBLAF7ZAYFY7QMGFKDSLPT53XIVT4WMYCBV2VO` |      2 |      0 | contact "USDC ready": USDC trustline                                         |
| Carol (`DEMO_RECIPIENT_SECRET`)      | `GCMSW7DAWCWJP42MF553ZRH233LZTXHOTQVQRL5AMYKVLSQYZFHO5ZJG` |      2 |      0 | contact without a trustline: the claim link (her `trust` needs ≥ 1.5 XLM)    |
| **Total**                            |                                                            | **44** | **30** |                                                                              |

Not funded by anyone: **Alice** is an OpenZeppelin smart account that relayer A deploys in M5 at the precomputed id
`CAH553ZKAWKPOK3XGF6AVW2BBN5LOBZC46TFDLY65SHUOMM56YKZX4XV` (relayer A's key is her rule-0 signer), and the **onboarding
router** is uploaded and deployed by relayer A in M3 at `CBWYFI6XWQI5C43GISIIUFXTJXBUI52QSNKKYC55GWMPLQRL2RAXT6TM`. Both
ids follow from relayer A and a fixed salt, so a second run of either script skips the deploy.

## Order: XLM first, then the trustline, then USDC

1. Send the XLM above to all six addresses (plain payments; each account is created by its first payment, minimum 1 XLM).
2. Right after the treasury's 3 XLM arrives, our script creates the USDC trustlines (treasury, seller payTo, Bob; 0.5 XLM
   reserve each from their own XLM, 0.001 XLM fee each), on Kristjan's go:
   `HM26_MAINNET_GO=yes bun scripts/mainnet/seed.ts --network pubnet --only trustlines`.
   A USDC payment to an account without the trustline fails, so wait for this step.
3. Send **30 USDC to the treasury** `GBJOFDKUKPHIPG34NEMVINELO36TS3QVVLNTXRO3SRUPEK5CPMYBVSPI`: asset code `USDC`, issuer
   **Circle `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`** (SAC
   `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`). Any wallet or an exchange withdrawal on the Stellar
   network works; no memo is needed. Any other "USDC" issuer is a different asset.

## Verify funding

```sh
bun scripts/mainnet/balances.ts     # read-only: each address's XLM and USDC against this table; exit 0 when all ok
```

It also says whether the router and Alice exist yet. Explorer: `https://stellar.expert/explorer/public/account/<address>`.

## What each later step spends (dry runs against pubnet RPC, 25 Oct ~16:40 UTC)

| Step | Script (each refuses without `HM26_MAINNET_GO=yes`; `--dry-run` simulates, never signs)       | Spends                                                                  | Dry run                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| M3   | `bun scripts/mainnet/router-deploy.ts [--write-env]`                                          | ≈ 2.51 XLM from relayer A (upload 2.49, deploy ≈ 0.02)                  | upload simulated at 2.4904 XLM; WASM hash and testnet bytes match; deploy needs the code         |
| M4   | `scripts/mainnet/seller-deploy.sh [--write-web-env]`, then `bun scripts/mainnet/smoke-pay.ts` | 0 XLM (OpenZeppelin Channels pays the fee); 0.10 USDC treasury → seller | wrangler bundles; the OZ key answers `/supported` for `stellar:pubnet`; client selection checked |
| M5   | `bun scripts/mainnet/seed.ts --network pubnet [--write-env]`                                  | 1.5 XLM reserves (trustlines) + ≈ 0.18 XLM (Alice)                      | Alice's deploy simulated at 0.1749 XLM, returns the precomputed id                               |

`bun scripts/mainnet/check-env.ts` checks that `apps/web/.env.mainnet` boots through the Worker's own Config layers.
