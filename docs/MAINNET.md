# Mainnet record

The recorded mainnet flow ran at [trynod.si](https://trynod.si) on 25 October 2026. The
[Claude run receipt](../evidence/mainnet/claude-run-2026-10-25.md) links the allowance install, x402 purchase,
payments inside and outside the allowance, claim-link onboarding, and revoke. Its transaction links distinguish
settlement from deployment.

[Deposit-first signup](../evidence/mainnet/deposit-2026-10-25T21-46Z.md) was also exercised on mainnet.
The [contract deployment record](../contracts/deployments/mainnet.json) holds router ids, WASM hashes, and deployment
transactions. [DEPLOY.md](DEPLOY.md) explains deployment; the [deployment log](../evidence/deployments/2026-10-25.md)
retains the dated releases. Read `/api/health` for the running release.

## Track M: completed bootstrap

The original Track M created the relayers, treasury, seller, demo recipients, onboarding router, and mainnet stage.
[`scripts/mainnet/`](../scripts/mainnet/) retains the guarded bootstrap and maintenance tools. The
[funding reference](mainnet-funding.md) records the original public addresses and script thresholds; it is not an
outstanding payment request. Earlier invite-only signup and the second spending threshold were superseded by open
signup and one allowance, as recorded in the [decisions log](SPEC.md#decisions-log).

Mainnet operations require the owner's explicit authorization. A historical go or receipt does not authorize a new
spend or deploy. The judges' sandbox remains separate at [testnet.trynod.si](https://testnet.trynod.si), with the
[judge test path](../evidence/JUDGE-TEST-PATH.md).
