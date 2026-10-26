# Smart accounts on Stellar: verified research (2026-10-25)

Historical research before S1. The [S1 results](../spikes/s1.md#contradictions-with-docsresearchsmart-accountsmd)
record corrections to these recommendations and the account implementation that actually passed.

Scope: a passkey-owned C-account, an Ed25519 "connection" key with an expiring onchain USDC allowance, and fees paid by our funded G account.
Everything below was checked today against npm, crates.io, GitHub, live testnet RPC (protocol 29) and stellar-cli 28.1.0.
**UNVERIFIED** marks anything we did not confirm directly.

## (a) Pinned versions

| Thing                                   | Pin                                                                                                                                                                | Released        | Notes                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `smart-account-kit` (npm)               | **0.8.0**                                                                                                                                                          | 2026-09-08      | Requires `@stellar/stellar-sdk@^16.3.0`. Its README says: "Do not install version 17".                                                         |
| `smart-account-kit-bindings` (npm)      | 0.4.0                                                                                                                                                              | 2026-08-19      | Pulled in by the kit                                                                                                                           |
| `@stellar/stellar-sdk`                  | **16.4.1** (`lts-16` tag, already in `packages/counter-client`)                                                                                                    | —               | `latest` is 17.3.0, which has a breaking XDR/auth API. Stay on 16.x.                                                                           |
| OZ smart account deployed on testnet    | WASM `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`                                                                                            | 2026-07-09      | Built from `stellar-contracts@1e513890`, a main commit after v0.7.1, with soroban-sdk 26.1.0. It uses the **v0.7.x ("legacy-concat") digest**. |
| `stellar-accounts` (crate)              | 0.8.0 (needs `soroban-sdk ^28.0.0`) / 0.7.3 (needs `^26.1.0`)                                                                                                      | both 2026-10-20 | **Neither works with soroban-sdk 29** (see Q2)                                                                                                 |
| Other OZ crates                         | `stellar-access`, `stellar-contract-utils`, `stellar-macros`, `stellar-tokens`, `stellar-governance`, `stellar-fee-abstraction`, `stellar-confidential`: all 0.8.0 | 2026-10-20      | The GitHub releases have **no WASM assets**                                                                                                    |
| `passkey-kit` (npm)                     | 0.19.1                                                                                                                                                             | 2026-09-18      | The repo moved to `stellar/passkey-kit`, and `kalepail/passkey-kit` is archived. Peer dependency `@stellar/stellar-sdk ^16.3.0`.               |
| `@openzeppelin/relayer-plugin-channels` | 0.21.0                                                                                                                                                             | 2026-09-24      | Only needed if we use OZ Channels                                                                                                              |
| stellar-cli                             | **28.1.0 (latest)**                                                                                                                                                | 2026-09-26      | There is no 29.x release. `main` is at 30.0.0 and unreleased.                                                                                  |
| soroban-sdk                             | 29.0.1 (stable). 30.0.0-rc.1 exists.                                                                                                                               | 2026-10-12      | Our workspace pin                                                                                                                              |
| Testnet                                 | protocol 29, RPC/core 30.0.0                                                                                                                                       | —               | `getVersionInfo` today, latest ledger ≈ 5,380,755                                                                                              |

**Testnet contracts that already exist and are live today** (from `stellar/smart-account-kit` `docs/deployments-protocol-27-2026-07-09.md`, re-checked with `stellar contract info interface` / `fetch`):

| Role                                                | Testnet ID                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Smart account WASM (deploy one instance per wallet) | hash `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`             |
| WebAuthn (secp256r1) verifier                       | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F`                          |
| Ed25519 verifier                                    | `CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4`                          |
| Spending-limit policy                               | `CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G`                          |
| Simple threshold policy                             | `CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG`                          |
| Weighted threshold policy                           | `CCMZ6X4KM3RC7HXWCZDTH7CMWIJXFPN6HLGKJBM63MCOW2AJ2V5W7YXY`                          |
| Native XLM SAC                                      | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`                          |
| **USDC SAC** (Circle testnet)                       | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`. `decimals()` returns 7. |

There is no factory contract. Each wallet is a fresh `deploy` of the account WASM with constructor arguments (`signers`, `policies`).

## (b) Findings

### Q1. Smart Account Kit: CONFIRMED, with two important corrections

- Repo: https://github.com/stellar/smart-account-kit. npm: `smart-account-kit@0.8.0`. Docs: the repo README and `docs/`, plus the Stellar guide at https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets.
- The guide presents Smart Account Kit (SAK) and Passkey Kit as **siblings, not interchangeable**: "Reach for [SAK] when you want thresholds, spending limits, or other policy-driven rules." The prior claim holds.
- SAK provides:
  - `createWallet` (passkey registration plus deploy), `connectWallet`, and `kit.signers` (add, addBatch, remove)
  - `kit.rules` (add, `updateExpiration`, remove, …) and `kit.policies` (add, remove)
  - typed policy clients for threshold, weighted-threshold and spending-limit
  - `createEd25519Signer`, `Ed25519Signer`, `kit.externalSigners.addEd25519FromSecret`, and Delegated (G) signers
  - `kit.signAuthEntry(entry, {contextRuleIds, expiration})` (passkey), `kit.transfer`, `signAndSubmitAdmin`, `resimulateAndAssemble`
  - `RelayerClient` (POST `{func, auth}`, reply `{success, data:{hash}}`) and a Cloudflare `relayer-proxy/` that fronts OZ Channels
  - a Mercury indexer client
  - Exported low-level helpers: `computeEntryAuthDigest`, `signerToScVal`, `buildDirectTokenTransfer`, `createSpendingLimitParams`, `LEDGERS_PER_DAY`.
- **Correction 1, digest version:** SAK 0.8.0 signs `auth_digest = sha256(signature_payload ‖ scvVec(context_rule_ids).toXDR())`. That is the **v0.7.x digest**, so SAK 0.8.0 **cannot authorize stellar-accounts v0.8.0 accounts**.
  - Open PR [stellar/smart-account-kit#17](https://github.com/stellar/smart-account-kit/pull/17) (2026-10-22, unmerged) adds per-WASM digest selection (`legacy-concat` vs `preimage-v1`).
  - Its build table: v0.7.3 is hash `203e2970…` (legacy digest) and v0.8.0 is `c514d35e…` (new digest). **Neither is uploaded to testnet yet.**
  - This confirms the OZ guidance: pair today's client with a v0.7.x account. The npm package name "0.8.0" is unrelated to stellar-accounts 0.8.0.
- **Correction 2, no headless Ed25519 signing in 0.8.0:** every `multiSigners.*` call submits the transaction and needs a connected wallet. A sign-only path, `signAuthEntryWithSigners`, is in open PR [#14](https://github.com/stellar/smart-account-kit/pull/14). It was written for an MCP/x402 agent with a `CallContract(USDC)` rule plus `spending_limit`, which is exactly our case. Issue #13 describes it.
  - Workaround: compose the signature ourselves in about 25 lines with stellar-sdk `authorizeEntry` (snippet in (c)), or use SAK's exported `Ed25519Signer` and `computeEntryAuthDigest`.
- Fee sponsoring: `relayerUrl` posts `{func, auth}`. SDF runs a testnet proxy at `https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev`, which answered `{"status":"ok","network":"testnet"}` today.
  - SAK's default **deployer keypair is public and shared**. Never fund it or use it as a transaction source.
  - Use `deployerSecret` (our G; this changes the derived addresses) or `createWallet(..., {autoSubmit:false})` and submit `{func, auth}` ourselves.
- SAK says it is unaudited. The testnet account build predates the v0.7.3 security fix [GHSA-jpg9-m7w4-c7wc](https://github.com/OpenZeppelin/stellar-contracts/security/advisories/GHSA-jpg9-m7w4-c7wc). That fix only concerns **Delegated** signers, so **do not use Delegated signers**. External passkey and Ed25519 signers are unaffected.

### Q2. OpenZeppelin `stellar-accounts`: model CONFIRMED, but it does not build with SDK 29

- Source at v0.7.3, the semantics of the deployed build:
  - [smart_account/mod.rs](https://github.com/OpenZeppelin/stellar-contracts/blob/v0.7.3/packages/accounts/src/smart_account/mod.rs)
  - [smart_account/storage.rs](https://github.com/OpenZeppelin/stellar-contracts/blob/v0.7.3/packages/accounts/src/smart_account/storage.rs)
  - [policies/spending_limit.rs](https://github.com/OpenZeppelin/stellar-contracts/blob/v0.7.3/packages/accounts/src/policies/spending_limit.rs)
  - [example account](https://github.com/OpenZeppelin/stellar-contracts/blob/v0.7.3/examples/multisig-smart-account/account/src/contract.rs)
- Docs: https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account (also `/context-rules`, `/policies`, `/signers-and-verifiers`).
- **SDK compatibility, verified with `cargo generate-lockfile`:** soroban-sdk 28 and 29 **cannot share one Cargo workspace**. Resolution fails on the `soroban-wasmi` links conflict.
  - stellar-accounts 0.8.0 needs `^28`. OZ `main` is still on 28.0.0, and there is no SDK 29 PR.
  - So OZ code cannot go into `contracts/` (pinned to 29.0.1). Building it would need a separate workspace on soroban-sdk 28.0.0, which **we do not need**: the contracts are already deployed.
  - Contracts built with older SDKs run on protocol 29. The SDK 26 builds above work today.
- Shapes (v0.7.x):
  - `Signer = Delegated(Address) | External(verifier: Address, key_data: Bytes)`. The Ed25519 key is 32 bytes. The WebAuthn key is the 65-byte uncompressed P-256 key followed by the credential id.
  - `ContextRuleType = Default | CallContract(Address) | CreateContract(BytesN<32>)`
  - `ContextRule { id, context_type, name, signers, signer_ids, policies: Vec<Address>, policy_ids, valid_until: Option<u32> }`
  - `AuthPayload { signers: Map<Signer, Bytes>, context_rule_ids: Vec<u32> }` is the `__check_auth` signature type. There must be **one rule id per auth context**, chosen by the caller. There is no auto-discovery.
  - `add_context_rule(context_type, name ≤20B, valid_until: Option<u32>, signers: Vec<Signer>, policies: Map<Address, Val>) -> ContextRule`
  - Also: `add_signer`, `batch_add_signer`, `remove_signer(rule, signer_id)`, `add_policy(rule, policy, install_param)`, `remove_policy`, `update_context_rule_valid_until`, `update_context_rule_name`, `remove_context_rule`, `execute(target, fn, args)`, `upgrade`.
  - Limits: 15 signers and 5 policies per rule.
- **Admin gating:** every mutator calls `e.current_contract_address().require_auth()`. That auth context is `Contract(self, fn, args)`, so only a `Default` rule or a `CallContract(self)` rule can authorize it.
  - The passkey sits on rule 0, `Default` (created by the constructor).
  - The connection key goes **only** on `CallContract(USDC_SAC)`, which makes it unable to administer the account.
  - Any signer in the `AuthPayload` that is not in a selected rule fails with `UnauthorizedSigner` (3016).
- **Expiry:** a rule is rejected when `valid_until < ledger.sequence()`, so it is valid _through_ `valid_until`. It is a **ledger number** (about 5 s per ledger, `LEDGERS_PER_DAY = 17280`), not a timestamp. Expired rules fail with `UnvalidatedContext` (3002) and are not auto-deleted.
- **Revocation:** `remove_context_rule(id)` also tries each policy's `uninstall`. Other options are `remove_signer` or lowering the limit (`set_spending_limit`). All of them are admin operations, so they need the passkey. `update_context_rule_valid_until` rejects past values (`PastValidUntil`, 3005), so revoke by removing, not by back-dating.
- **SpendingLimit, CONFIRMED rolling window:**
  - Params: `SpendingLimitAccountParams { spending_limit: i128, period_ledgers: u32 }`. It installs only on `CallContract` rules (error 3227 otherwise).
  - State is keyed by `(account, rule_id)`, so **each connection rule gets its own budget**.
  - `enforce` accepts **only** `fn_name == "transfer"` with `args[2]: i128`. Any other function on that contract, such as `approve`, fails with `NotAllowed` (3223).
  - It sums the history and evicts entries with `ledger ≤ now − period_ledgers`. It rejects when `total + amount > limit` (`SpendingLimitExceeded`, 3221). History is capped at 1000 entries (3224).
  - It counts any SAC `transfer` that the account authorizes **under that rule**. Payments approved by passkey under rule 0 do not consume it.
  - **Turning it into a non-replenishing "5 USDC until tomorrow" budget:** set `valid_until = now + ~17280` and `period_ledgers ≥ valid_until − now` (for example 20000), so nothing rolls off before the rule expires.
  - `set_spending_limit` changes only the limit, not the period.
- Other policies: SimpleThreshold (`{threshold}`) and WeightedThreshold. A rule **without** policies requires _all_ its signers. A rule _with_ policies requires at least one matched signer, and the policies decide the rest.
- Passkeys: the WebAuthn verifier calls the native `e.crypto().secp256r1_verify` host function (CAP-51, since protocol 21) and checks the challenge, UP and UV. CONFIRMED.
- **v0.8.0 breaking changes:**
  - The digest becomes `sha256(AuthDigestPreimage{account, signature_payload, context_rule_ids}.to_xdr())`.
  - Error codes were renumbered.
  - Includes the Delegated-signer security fix.
  - Adds a factory example.
  - Release notes: https://github.com/OpenZeppelin/stellar-contracts/releases/tag/v0.8.0. The prior claim is CONFIRMED.

### Q3. Passkey Kit as a fallback

- `passkey-kit@0.19.1`, https://github.com/stellar/passkey-kit. Uses its own wallet contract with a flat `Signatures` map, and is **not** compatible with OZ accounts. Testnet wallet WASM `97ce0478…`.
- Ed25519 signers: yes. `addEd25519(G…, limits, store, expiration?)`.
  - `SignerLimits` scope a signer to contracts, optionally with required co-signers.
  - `expiration` is a **UNIX timestamp**.
  - An amount cap needs a **policy signer**. The bundled `contracts/sample-policy` is a cumulative rolling window, but `WINDOW_ALLOWANCE = 100_000_000` and `WINDOW_SECONDS = 86400` are **compile-time constants**. Per-connection budgets would mean writing and deploying our own policy, on soroban-sdk 27.
- Launchtube is **retired**: the repo was archived 2026-03-09, and `testnet.launchtube.xyz` did not resolve today. Passkey Kit now submits through OZ Relayer Channels.
- **Which is faster for a ~20 h build: SAK + OZ.** Everything we need is already deployed on testnet and live: account WASM, WebAuthn and Ed25519 verifiers, and a parameterized cumulative spending-limit policy with per-rule state and ledger-based expiry. Passkey creation and passkey signing (approval link) are already solved in SAK, and its README documents exactly our pattern (`CallContract(token)` rule + `spending_limit`). Our only custom code is about 25 lines of headless Ed25519 signing. Passkey Kit would require a new policy contract (Rust, a different SDK major, deploy, audit-by-eye) to get per-connection amount caps.

### Q4. Fee sponsoring without a relayer: pattern CONFIRMED

- The funded classic G is the transaction source and fee payer, and signs only the envelope. The C-account authorizes through a `SorobanAuthorizationEntry` with **address credentials**. On protocol ≥28, simulation returns CAP-71 `ADDRESS_V2` (address-bound payload) by default.
- Its `signature` ScVal is the `AuthPayload` map that `__check_auth` decodes. The C-account needs no XLM. SAK's own `resimulateAndAssemble` does exactly this.
- Flow with `@stellar/stellar-sdk@16.4.1`:
  1. Build `invokeHostFunction(SAC.transfer(C, to, amt))` with source G.
  2. `simulateTransaction` in record mode. This returns unsigned auth entries with a random nonce.
  3. `authorizeEntry(entry, callback, validUntilLedger, passphrase)`. The callback gets `(preimage, payload = sha256(preimage))` and returns `{ signatureScVal }`. `authorizeEntry` writes `signatureExpirationLedger` and picks the v1/v2 preimage.
  4. **Re-simulate** with the signed entries (pass `authMode "enforce"`).
  5. `rpc.assembleTransaction` keeps existing auth when present (verified in the 16.4.1 source).
  6. `tx.sign(G)` and `sendTransaction`.
- **Pitfalls:**
  1. Record-mode simulation does **not** run a custom account's `__check_auth`. The verifier call, the policy call and the policy's **read-write** storage entry are missing from the footprint and fee until you re-simulate after signing.
  2. Never hand-roll the preimage. v2 credentials bind the address. Use `authorizeEntry` or `buildAuthorizationEntryPreimage`.
  3. `TransactionBuilder.build()` increments the `Account` sequence. Rebuild each attempt from `new Account(G, seq)`, or you get `tx_bad_seq`.
  4. Keep expiration short (latest + ~60 ledgers). The nonce is consumed on success, so a signed entry cannot be replayed.
  5. Re-simulating does not change the auth entries, so signatures stay valid. Changing the invocation (amount, recipient) does invalidate them.
  6. A single G source serializes on its sequence number. Use a few sponsor accounts for parallel payments.
  7. The rule id goes into the digest **and** into `AuthPayload.context_rule_ids`, and the two must match.
- OZ Channels (live on testnet): `GET https://channels.openzeppelin.com/testnet/gen` returned an API key today (201). `@openzeppelin/relayer-plugin-channels`, `submitSorobanTransaction({func, auth})`. It is trivial but adds a dependency, and our own G is simpler for the agent path.
  - For the **browser** passkey approval, either point SAK's `relayerUrl` at SDF's proxy, or (better) at our own endpoint that implements the same `{func, auth}` → `{success:true, data:{hash}}` contract and submits with our G.
- Guides: https://docs.openzeppelin.com/relayer/guides/stellar-channels-guide and https://developers.stellar.org/docs/tools/openzeppelin-relayer

### Q5. Testnet USDC: CONFIRMED

- Issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (https://developers.circle.com/stablecoins/usdc-contract-addresses). Mainnet issuer for reference: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`.
- SAC: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`. Derived with `stellar contract id asset`. Live: `name()` returns `"USDC:GBBD…"` and `decimals()` returns **7**, so 1 USDC = 10_000_000.
- https://faucet.circle.com lists **Stellar Testnet**: 20 USDC per request, once per 2 h per address. It needs a G-address with a USDC trustline. Whether it can pay a C-address directly is UNVERIFIED (assume no).
- Move USDC into the C-account with a SAC `transfer` from the G that holds it: `stellar token transfer` (shown in (c)). A C-address needs no trustline.

### Q6. stellar-cli: no upgrade needed

- 28.1.0 is the latest release. Protocol 29's host (`soroban-env-* 29.0.x`) still uses `stellar-xdr =28.0.0`, the same XDR as CLI 28.1.0, so there is no XDR skew.
- Verified today against protocol-29 testnet with 28.1.0: `contract info interface`, `contract fetch --wasm-hash`, a simulated `contract invoke --send=no`, and a `deploy --build-only` with the account's constructor arguments.
- UNVERIFIED by us: a real `deploy` or `invoke` with `--send`. It is expected to work.
- Quirk: `deploy --wasm-hash … --build-only` errors with "Must provide either --wasm or --wasm-hash". `--wasm file` works. A non-build-only deploy with `--wasm-hash` is UNVERIFIED.
- If an upgrade is ever needed: `curl -fsSL https://github.com/stellar/stellar-cli/raw/main/install.sh | sh` (the script exists), or `cargo install --locked stellar-cli@<ver>`.

## (c) Recommended path for spike S1

Goal: on testnet, an Ed25519 connection key pays 1 USDC from a C-account under a 5 USDC, about 1-day rule with our G paying the fee. Then a 5 USDC payment fails with `#3221`.
For the spike, the owner is an Ed25519 key standing in for the passkey. The passkey path is SAK's demo (`createWallet`, then `kit.signAuthEntry(entry,{contextRuleIds:[0]})`) and slots into rule 0 unchanged.

```bash
N="--network testnet"
stellar keys generate sponsor $N --fund     # fee payer / tx source (our backend G)
stellar keys generate funder  $N --fund     # holds faucet USDC
stellar keys generate owner                  # stand-in for passkey (rule 0)
stellar keys generate conn                   # MCP connection key (USDC rule)
stellar tx new change-trust --source funder --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 $N
stellar keys public-key funder               # -> paste into https://faucet.circle.com (Stellar Testnet, 20 USDC)
OWNER_HEX=$(stellar strkey decode "$(stellar keys public-key owner)" | jq -r .public_key_ed25519)
stellar contract fetch --wasm-hash 1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a $N -o /tmp/oz-account.wasm
stellar contract deploy --wasm /tmp/oz-account.wasm --source sponsor $N --alias s1-account -- \
  --signers "[{\"External\":[\"CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4\",\"$OWNER_HEX\"]}]" \
  --policies '{}'
stellar token transfer --id CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA --from funder \
  --to "$(stellar contract alias show s1-account $N)" --amount 100000000 $N        # 10 USDC into the C-account
```

The core of the TypeScript spike (Bun, `@stellar/stellar-sdk@16.4.1`). One helper covers both the admin call (owner key, rule `[0]`) and the payment (conn key, rule `[ruleId]`):

```ts
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
const server = new rpc.Server('https://soroban-testnet.stellar.org'),
  NET = Networks.TESTNET
const ED25519_VERIFIER = 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  SPEND = 'CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G'
const extSigner = (kp: Keypair) =>
  xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    new Address(ED25519_VERIFIER).toScVal(),
    xdr.ScVal.scvBytes(kp.rawPublicKey()),
  ])
const u32s = (ids: number[]) => xdr.ScVal.scvVec(ids.map(i => xdr.ScVal.scvU32(i)))

async function invokeAs(
  sponsor: Keypair,
  signer: Keypair,
  ruleIds: number[],
  contract: string,
  fn: string,
  args: xdr.ScVal[],
) {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
  )
  const seq = (await server.getAccount(sponsor.publicKey())).sequenceNumber()
  const build = (auth: xdr.SorobanAuthorizationEntry[]) =>
    new TransactionBuilder(new Account(sponsor.publicKey(), seq), { fee: '1000000', networkPassphrase: NET })
      .addOperation(Operation.invokeHostFunction({ func, auth }))
      .setTimeout(60)
      .build()
  const sim1 = await server.simulateTransaction(build([])) // record mode: unsigned entries + nonce
  if (!rpc.Api.isSimulationSuccess(sim1)) throw new Error(sim1.error)
  const until = (await server.getLatestLedger()).sequence + 60
  const auth = await Promise.all(
    sim1.result!.auth.map(e =>
      authorizeEntry(
        e,
        async (_pre, payload) => {
          const digest = hash(Buffer.concat([payload, u32s(ruleIds).toXDR()])) // v0.7.x "legacy-concat" digest
          return {
            signatureScVal: xdr.ScVal.scvMap([
              // AuthPayload, keys sorted
              new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('context_rule_ids'), val: u32s(ruleIds) }),
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('signers'),
                val: xdr.ScVal.scvMap([
                  new xdr.ScMapEntry({ key: extSigner(signer), val: xdr.ScVal.scvBytes(signer.sign(digest)) }),
                ]),
              }),
            ]),
          }
        },
        until,
        NET,
      ),
    ),
  )
  const signed = build(auth)
  const sim2 = await server.simulateTransaction(signed, undefined, 'enforce') // runs __check_auth: verifier + policy footprint
  if (!rpc.Api.isSimulationSuccess(sim2)) throw new Error(sim2.error) // e.g. Error(Contract, #3221)
  const tx = rpc.assembleTransaction(signed, sim2).build()
  tx.sign(sponsor)
  return server.pollTransaction((await server.sendTransaction(tx)).hash)
}
// 1) owner (rule 0) adds the connection rule: CallContract(USDC), conn signer, 5 USDC, ~1 day
const now = (await server.getLatestLedger()).sequence
const params = nativeToScVal(
  { period_ledgers: 20_000, spending_limit: 50_000_000n },
  { type: { period_ledgers: ['symbol', 'u32'], spending_limit: ['symbol', 'i128'] } },
)
await invokeAs(sponsor, owner, [0], ACCOUNT, 'add_context_rule', [
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CallContract'), new Address(USDC).toScVal()]),
  nativeToScVal('mcp-conn-1', { type: 'string' }),
  nativeToScVal(now + 17_280, { type: 'u32' }) /* Option<u32> Some = bare u32 */,
  xdr.ScVal.scvVec([extSigner(conn)]),
  xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: new Address(SPEND).toScVal(), val: params })]),
])
// 2) conn pays 1 USDC (ruleId = 1 for the first added rule; read get_context_rules_count / the event to be sure)
await invokeAs(sponsor, conn, [1], USDC, 'transfer', [
  new Address(ACCOUNT).toScVal(),
  new Address(MERCHANT).toScVal(),
  nativeToScVal(10_000_000n, { type: 'i128' }),
])
// 3) conn tries 5 USDC -> sim2 fails with Error(Contract, #3221) SpendingLimitExceeded
```

Notes:

- Payments pass `ruleIds = [ruleId]`. Admin calls by the owner pass `[0]`.
- A token `transfer` from the C-account produces exactly one auth context, so it needs exactly one rule id.
- Read the spend state with `stellar contract invoke --id CABXBYJ… -- get_spending_limit_data --context_rule_id 1 --smart_account <C>` (view call).
- The approval link uses the same flow: the backend builds and simulates the exact `transfer` and stores the unsigned entry. The browser SAK `kit.signAuthEntry(entry, {contextRuleIds:[0], expiration})` signs it with the passkey and posts it back. The backend re-simulates, assembles and submits as G.

**Fallback path** (in order):

1. If composing the AuthPayload fights us, install SAK from the PR #14 branch (`github:stellar/smart-account-kit#feat/sign-auth-entry-with-signers`, needs a build step because the package is pnpm-built) and use `signAuthEntryWithSigners(entry, [Ed25519Signer.fromSecret(..)], {contextRuleIds, expiration})`.
2. If the spending-limit policy misbehaves, keep the rule's `valid_until` and enforce the amount off-chain in the MCP server. That is weaker, and we would have to say so in the demo.
3. If the OZ stack is blocked entirely, switch to Passkey Kit with an `Ed25519` signer limited to the USDC contract with `expiration`, plus our own fork of `sample-policy` with per-wallet params. Budget about 4 to 6 h for that.

## (d) Open risks, ranked

1. **SDK 17 incompatibility.** SAK 0.8.0 and Passkey Kit both pin `@stellar/stellar-sdk ^16.3.0`. Anyone running `bun add @stellar/stellar-sdk` gets 17.3.0, whose XDR/auth API breaks them. Pin exactly 16.4.1 in every package.
2. **Digest/version skew.** If anyone deploys a stellar-accounts **0.8.0** account (or SAK PR #17 lands and we upgrade), signatures silently fail until the digest scheme is switched. Stay on WASM `1b5f4534…` for the hackathon.
3. **Re-simulation and resources.** Skipping the enforce-mode re-simulation leads to a footprint miss on the policy's read-write entry, and the transaction fails. This is the most likely first bug.
4. **Rule-id bookkeeping.** The caller picks the rule id, and the wrong id fails with `UnvalidatedContext` or `UnauthorizedSigner`. Persist the rule id per connection from the `add_context_rule` return value or event.
5. **SAK `connectWallet` strictness** (birth provenance, accepted WASM hashes, Mercury indexer freshness, one exact live signer). It is UNVERIFIED whether it still connects once we add Ed25519 rules or deploy outside `createWallet`. Create user wallets through `createWallet` (with `deployerSecret` or `autoSubmit:false`) and test reconnecting early.
6. **Testnet USDC supply.** The faucet gives 20 USDC per 2 h per address. Pre-fund several funder Gs today.
7. **Sponsor sequence contention.** One G source serializes concurrent agent payments. Use 2 or 3 sponsor accounts, or a queue.
8. **The deployed account lacks the GHSA-jpg9 fix.** Harmless as long as there are no Delegated signers. Mention it in the README's security notes.
9. **Ledger-based expiry.** Show "expires ≈ <time>" in the UI, but the source of truth is `valid_until`, which drifts with ledger close times of about 5 to 6 s.
