# Mainnet bootstrap funding reference

These are the public addresses and original funding targets from 25 October 2026. Bootstrap is complete; the table
is retained because the mainnet scripts reference these thresholds. It does not show current balances or request a
new transfer. The original 30 USDC treasury target was reduced to 10 USDC for the first demo.

| Account                              | Address                                                    |    XLM |   USDC | Used for                                                                     |
| ------------------------------------ | ---------------------------------------------------------- | -----: | -----: | ---------------------------------------------------------------------------- |
| relayer A (`RELAYER_SECRET`, first)  | `GBVYA2V4SMVPXFRPVB5FEFCADW7RXFIACR2HBLN2WP3RHAZKL267YG5X` |     25 |      0 | fee payer; router upload + deploy (M3), Alice's deploy (M5), pocket reserves |
| relayer B (`RELAYER_SECRET`, second) | `GDMYACRM646Z4QIUPIAQZ2W3HSKAO2LESWCME73RSCCETSQKSL6HCAGP` |     10 |      0 | second fee payer (parallel sequence numbers)                                 |
| treasury (`TREASURY_SECRET`)         | `GBJOFDKUKPHIPG34NEMVINELO36TS3QVVLNTXRO3SRUPEK5CPMYBVSPI` |      3 |     30 | tops up the owner wallet (M7), pays the seller smoke test (M4)               |
| seller payTo (`PAY_TO`)              | `GAJ6XSMEBPLATVHRQVQK5QTL7GYGGYGHC2IFNIQZBMRNIYWHVFOAM47G` |      2 |      0 | receives x402 payments; USDC trustline                                       |
| Bob                                  | `GAVERRBSX7HTUN6EHQIBLAF7ZAYFY7QMGFKDSLPT53XIVT4WMYCBV2VO` |      2 |      0 | contact "USDC ready": USDC trustline                                         |
| Carol (`DEMO_RECIPIENT_SECRET`)      | `GCMSW7DAWCWJP42MF553ZRH233LZTXHOTQVQRL5AMYKVLSQYZFHO5ZJG` |      2 |      0 | contact without a trustline: the claim link (her `trust` needs ≥ 1.5 XLM)    |
| **Total**                            |                                                            | **44** | **30** |                                                                              |

Public account and demo ids also live in [`scripts/demo/seeds.pubnet.json`](../scripts/demo/seeds.pubnet.json).
Router ids and deployment hashes live in [`contracts/deployments/mainnet.json`](../contracts/deployments/mainnet.json).
Secrets remain in gitignored `apps/web/.env.mainnet` and `scripts/demo/.env.pubnet`, mode 600.

`bun scripts/mainnet/balances.ts` reads current balances and compares them with the original thresholds. A shortfall
against this bootstrap table is not evidence that an already completed deployment failed.

See [MAINNET.md](MAINNET.md) for the completed flow and [DEPLOY.md](DEPLOY.md) for operations. The original funding
instructions and dry-run estimates remain in Git history.
