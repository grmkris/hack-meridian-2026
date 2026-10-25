# x402 on Stellar: verified research for spike S2

Verified 2026-10-25 against npm, the `x402-foundation/x402` repo (`main` at commit 62fc03e5, 2026-10-23), the published
tarballs (I read `dist/` directly), Stellar docs, and live probes. Testnet RPC reports `protocolVersion: 29`
(stellar-core 30.0.0). Anything not checked first-hand is marked **UNVERIFIED**.

## (a) Pinned versions

| Package                                              | Pin                                      | Notes                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@x402/stellar`                                      | **2.28.0** (latest, 2026-09-29)          | deps: `@x402/core ~2.28.0`, `@stellar/stellar-sdk ^16.3.0`. Node >= 22                                                                                                                                                |
| `@x402/core`                                         | **2.28.0**                               | `zod ^3.24.2`                                                                                                                                                                                                         |
| `@x402/mcp`                                          | **2.28.0**                               | deps: `@x402/core ~2.28.0`, `@modelcontextprotocol/sdk ^1.12.1` (latest is 1.32.2)                                                                                                                                    |
| `@x402/hono`                                         | **2.28.0**                               | peers `hono ^4` (latest 4.13.14), `@x402/paywall` (optional)                                                                                                                                                          |
| `@x402/express` / `@x402/fetch` / `@x402/extensions` | **2.28.0**                               | `payment-identifier` lives in `@x402/extensions/payment-identifier`                                                                                                                                                   |
| `@stellar/stellar-sdk`                               | **16.4.1** for the x402 path             | 17.3.0 is latest, but `@x402/stellar` needs `^16`. `main` already requires 16.4.1 (PR #3904, axios advisories). 16.4.1's `authorizeEntry` accepts `{ signatureScVal }`, which is the hook a smart-account payer needs |
| `@stellar/mpp`                                       | 0.7.1 (2026-07-02)                       | peers `mppx ^0.6.29`, `@stellar/stellar-sdk ^15.1.0`. Deferred, see Q5                                                                                                                                                |
| Froggy (`ethglobal-online-2026/packages/payments`)   | `@x402/{core,evm,hedera,svm}` **2.25.0** | **Confirmed** in its `package.json`. 2.25.0 → 2.28.0 is a minor bump on the same v2 wire format                                                                                                                       |

## (b) Findings

### Q1. `@x402/stellar`

- npm: https://www.npmjs.com/package/@x402/stellar. Source:
  https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/stellar. Spec:
  https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md
- Subpaths `/exact/client`, `/exact/server`, `/exact/facilitator` each export their own `ExactStellarScheme`.
- **Client signer type**: `ClientStellarSigner = { address: string; signAuthEntry: SignAuthEntry; signTransaction?: SignTransaction }`
  (SEP-43 shapes from `@stellar/stellar-sdk/contract`). The facilitator side uses
  `Ed25519Signer`/`FacilitatorStellarSigner` with `signTransaction` required.
- **Keypair helper**: `createEd25519Signer(secretS..., "stellar:testnet")`. Client registration:
  `new x402Client().register("stellar:*", new ExactStellarScheme(signer, { url: rpcUrl }))`.
- **Wire flow** (`dist/esm/chunk-EGJCLWK3.mjs`): build `AssembledTransaction` for `USDC.transfer(from, payTo, amount)`,
  simulate (recording), `tx.signAuthEntries({address, signAuthEntry, expiration: currentLedger + ceil(maxTimeoutSeconds/ledgerSecs)})`,
  re-simulate, and send payload `{ transaction: <base64 tx XDR> }`.

  So the claim **"signs Soroban auth entries, not transactions" is confirmed**, with one nuance: the payload is an unsigned
  transaction envelope that carries the signed auth entry. The facilitator rebuilds it with its own source and fee.

- **PaymentRequirements** (spec, and matches the live 402s I decoded):
  `{"scheme":"exact","network":"stellar:testnet","amount":"1000000","asset":"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA","payTo":"G…|C…|M…","maxTimeoutSeconds":60,"extra":{"areFeesSponsored":true}}`.
  - Network ids are `stellar:testnet`, `stellar:pubnet` and `stellar:*`.
  - `asset` **is the USDC SAC contract id**: `USDC_TESTNET_ADDRESS`, 7 decimals, so `$0.10` = `"1000000"`.
  - There is no `feePayer` field. `extra.areFeesSponsored` comes from the facilitator's `/supported`, and the client
    **throws unless it is `true`**.
- **Does the facilitator run the payer's `__check_auth`? Yes.** `verify()` calls `simulateTransaction` on the client's
  transaction with the auth entries already signed, which puts it in enforcing mode, and `settle()` re-simulates.
  So a C-address payer's `__check_auth` runs twice in simulation and then once on-chain. Its cost counts toward the fee
  ceiling, any event it emits is seen by the event scan, and it must not add auth entries of its own (the facilitator
  requires exactly the payer's entry, with no sub-invocations and nothing pending).

  Credentials may be V1 address or CAP-71 V2 address. `AddressWithDelegates` and source-account credentials are
  rejected.

- **Contract-account (C) payer: REFUTED as shipped.** The type doc says "Supports both classic (G) and contract (C)
  accounts", but at runtime it does not work:
  - The 2.28.0 client never passes `authorizeEntry`, so the SDK's `signAuthEntries` returns a bare buffer and falls into
    the ed25519 branch, which calls `Keypair.fromPublicKey("C…")` and throws `invalid version byte`.
  - Tracked as issue [#3158](https://github.com/x402-foundation/x402/issues/3158) (open). The fix is PR
    [#3860](https://github.com/x402-foundation/x402/pull/3860) (open, unreviewed; it adds an optional
    `authorizeEntry` to `ClientStellarSigner`). The PR shows a testnet settlement from a `__check_auth` account with an
    ed25519 session key and an on-chain spending policy.
  - `main` still has the old call.
- **Facilitator-side limits on smart-account payers (all open):**
  1. [#3352](https://github.com/x402-foundation/x402/issues/3352) / [#3764](https://github.com/x402-foundation/x402/issues/3764):
     `validateSimulationEvents` rejects _any_ contract event that is not `transfer`
     (`invalid_exact_stellar_payload_event_not_transfer`). OZ's `spending_limit` policy emits
     `spending_limit_enforced`, so **an OZ smart account with a spending limit cannot pay through the reference
     facilitator code**. #3764 reports the same failure against OZ Channels testnet. Fix: PR
     [#3399](https://github.com/x402-foundation/x402/pull/3399) (open), which only interprets events from
     `requirements.asset`.
  2. [#3515](https://github.com/x402-foundation/x402/issues/3515): `maxTransactionFeeStroops` defaults to 50,000. Measured
     against `https://x402.org/facilitator`, an OZ smart account (verifier + spending_limit) needed **324,039 stroops and
     was refused**; #3764 measured about 290k. A G-account payment costs about 23k. The payer cannot change the ceiling.
  3. [#3168](https://github.com/x402-foundation/x402/issues/3168): the 2-ledger expiration tolerance occasionally rejects
     valid payments when RPC load balancers disagree on the latest ledger.

### Q2. Stellar docs and live facilitator probes

- Quickstart (Express + fetch): https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide (200). It uses
  `FACILITATOR_URL = "https://www.x402.org/facilitator"`, `$0.01`, `stellar:testnet`, and does not pin package versions.
  Its client rewrites the fee to `"1"` "to prevent testnet facilitator limit issue".
- Overview: https://developers.stellar.org/docs/build/agentic-payments/x402/ (200; the old `/docs/build/apps/x402` returns
  308 to it). OZ page: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar (200). Agent CLI
  guide: https://developers.stellar.org/docs/tools/cli/agent-cli/guides/pay-for-apis-x402 (200).
- **Facilitators listed** (claim confirmed, plus a third):
  1. **x402.org ("Coinbase x402 Facilitator")**: testnet only, sponsored fees, no API key.
  2. **"Built on Stellar" (OpenZeppelin Relayer + x402 plugin)**: testnet `https://channels.openzeppelin.com/x402/testnet`,
     mainnet `https://channels.openzeppelin.com/x402`. Both need `Authorization: Bearer <key>`. Keys come from
     `https://channels.openzeppelin.com/testnet/gen` (no auth) or `/gen` (GitHub OAuth). Plugin source:
     https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator (v0.5.0, stellar-sdk ^17.0.1).
  3. **Vellar** (community, testnet only, unaudited, slow cold start): https://github.com/Vellar-Wallet/vellar-facilitator.
- **Live probes, 2026-10-25, one sample each. This is not an uptime measurement.**

| Endpoint                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET https://www.x402.org/facilitator/supported`                                             | **200**, 0.40 s. Stellar kind: `{"x402Version":2,"scheme":"exact","network":"stellar:testnet","extra":{"areFeesSponsored":true}}`. Stellar signers: `GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K`, `GC5OLUZ4WANPN6VT7YGTK2SRMZG762KOVKJXHWIO4K57UBASO2FMNRET`. Extensions: `builder-code`, `eip2612GasSponsoring`, `erc20ApprovalGasSponsoring`; **no `payment-identifier`**. Also serves base-sepolia, solana-devnet, algorand, aptos, hedera:testnet, xrpl:1 |
| `GET https://channels.openzeppelin.com/x402/testnet/supported` (no key)                      | **401** `{"success":false,"code":401,"error":"Unauthorized"}`. Mainnet `/x402/supported` is also 401 without a key                                                                                                                                                                                                                                                                                                                                                          |
| same, with a freshly generated testnet key (`/testnet/gen` → 201; key used once, not stored) | **200**, 0.50 s: `{"kinds":[{"extra":{"areFeesSponsored":true},"network":"stellar:testnet","scheme":"exact","x402Version":2}],"signers":{"stellar:testnet":["GCNJB6V5YIODDSSCWXZ2VOKMRPRVZ2V723RRQS6STXE6NWTGVOJY35CN"]}}`                                                                                                                                                                                                                                                  |

- The OZ plugin's verify (`src/stellar/verify.ts`, `utils.ts`) **also rejects any non-transfer contract event**. It checks
  the _client's_ `tx.fee` against `minResourceFee` (rejects if lower) and against an optional `maxTransactionFeeStroops`.
  The hosted ceiling is **UNVERIFIED**.
- **Wallet compatibility** (overview page): the wallet "must support auth-entry signing". Listed: Freighter extension
  (mobile not supported), Albedo, Hana, HOT, Klever, OneKey, Scopuly. **Smart accounts, passkeys and C-addresses are not
  mentioned**; the page only links OZ Smart Account docs. The agent-CLI guide says Stellar's announced smart-wallet
  "x402-MCP server" is "in active development, not shipped" and "There is no policy layer for x402 on Stellar today",
  which is exactly the gap our product fills.

### Q3. x402 over MCP and payment-identifier

- Spec: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md. **Claim confirmed**:
  - 402 = tool result with `isError: true`, `structuredContent` = `PaymentRequired`, and `content[0].text` =
    `JSON.stringify` of the same.
  - Retry carries `params._meta["x402/payment"]` = `PaymentPayload`.
  - Receipt is `result._meta["x402/payment-response"]` = `SettleResponse`.
  - A settlement failure returns `isError: true` and must not include the tool output.
  - Resource URL convention: `mcp://tool/<name>`.
- Implementation: **`@x402/mcp` 2.28.0** covers both sides.
  - Server: `createPaymentWrapper(resourceServer, { accepts, hooks })` (hooks: before/after execution, after settlement).
  - Client: `wrapMCPClientWithPayment(mcpClient, x402Client, { autoPayment, onPaymentRequested })`,
    `createx402MCPClient`, and `x402MCPClient.callTool` / `callToolWithPayment`, which return
    `{ content, isError, paymentMade, paymentResponse }`.
  - The package also emits and accepts the JSON-RPC error code `-32042` (SEP-1036) as a workaround for MCP SDK issue 774.
  - Examples: `examples/typescript/servers/mcp/`, `examples/typescript/clients/mcp/` (EVM-only).
  - **The MCP path has no Stellar e2e coverage**, so Stellar over MCP is UNVERIFIED. The transport is chain-agnostic.
- Payment-identifier spec: https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md
  (**confirmed**).
  - `extensions["payment-identifier"].info = { required, id }`, where `id` is 16–128 characters of `[A-Za-z0-9_-]`.
  - Same id + same payload → cached response. Same id + different fingerprint → 409. `required` with no id → 400.
  - TS helpers live in `@x402/extensions/payment-identifier`: `generatePaymentId`, `appendPaymentIdentifierToExtensions`
    (client, in an `onBeforePaymentCreation` hook), and `declarePaymentIdentifierExtension` /
    `paymentIdentifierResourceServerExtension` / `extractPaymentIdentifier` (server).
  - It is a payload-level extension, so `@x402/stellar` needs no support of its own. **Caching is the server's job**: the
    docs' "Step 2: Cache Responses After Settlement" is manual. Whether the middleware caches automatically is
    UNVERIFIED.
  - The x402.org facilitator does not advertise it.
  - On Stellar the auth-entry nonce already prevents a payload from settling twice on-chain.

### Q4. Fastest Stellar seller for the demo

- **Public testnet seller exists**: `GET https://stellar.org/x402-demo/api/protected/testnet` → **402**, which I decoded
  without paying:
  `{"scheme":"exact","network":"stellar:testnet","asset":"CBIELTK6…DAMA","payTo":"GCHEI4PQEFJOA27MNZRPQNLGURS6KASW76X5UZCUZIXCOJLKXYCXOR2W","amount":"100000","maxTimeoutSeconds":300,"extra":{"areFeesSponsored":true}}`
  ($0.01). Horizon shows it settling: last payment on 2026-10-17, about 11.7k–23k stroops each, always fee-bumped by
  `GA6THKUY…H7TL`. That address is neither the x402.org signer nor the OZ signer. It is probably the self-hosted
  `stellar/x402-stellar` facilitator in channel-account mode with the default 50k ceiling (**UNVERIFIED**). Expect it to
  reject our smart account. It is fine for a G-account smoke test.
- `https://x402.org/protected` offers only Base Sepolia and Solana devnet. `/protected/stellar/*` returns 404.
- Minimal middleware: **`@x402/hono` 2.28.0** (`paymentMiddleware(routes, x402ResourceServer)`). `@x402/express` has the same
  shape and is what the Stellar quickstart uses. Complete Bun seller:

```ts
// spikes/s2/seller/index.ts — bun run index.ts
import { Hono } from 'hono'

import { x402Facilitator } from '@x402/core/facilitator'
import { HTTPFacilitatorClient } from '@x402/core/server'
import type { FacilitatorClient } from '@x402/core/server'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { createEd25519Signer } from '@x402/stellar'
import { ExactStellarScheme as StellarFacilitatorScheme } from '@x402/stellar/exact/facilitator'
import { ExactStellarScheme } from '@x402/stellar/exact/server'

const NETWORK = 'stellar:testnet'
const PAY_TO = process.env.STELLAR_PAY_TO! // G… with a USDC trustline (or a C…, which needs no trustline)

const facilitator = (): FacilitatorClient => {
  if (process.env.FACILITATOR !== 'local') return new HTTPFacilitatorClient({ url: 'https://www.x402.org/facilitator' })
  // In-process facilitator for smart-account payers: XLM-funded G key, higher fee ceiling.
  const f = new x402Facilitator().register(
    NETWORK,
    new StellarFacilitatorScheme([createEd25519Signer(process.env.FACILITATOR_STELLAR_SECRET!, NETWORK)], {
      maxTransactionFeeStroops: 1_000_000,
    }),
  )
  return {
    verify: (p, r) => f.verify(p, r),
    settle: (p, r) => f.settle(p, r),
    getSupported: async () => f.getSupported(),
  }
}

const server = new x402ResourceServer(facilitator()).register(NETWORK, new ExactStellarScheme())
const app = new Hono()
app.use(
  paymentMiddleware(
    {
      'GET /paid/quote': {
        accepts: [{ scheme: 'exact', price: '$0.10', network: NETWORK, payTo: PAY_TO }],
        description: 'S2 paid quote',
        mimeType: 'application/json',
      },
    },
    server,
  ),
)
app.get('/paid/quote', c => c.json({ quote: 'Ledgers close every ~5s.' }))
export default { port: 4021, fetch: app.fetch }
```

The local facilitator still runs the 2.28.0 event scan. If the payer's `__check_auth` emits events, either apply PR
#3399 with `bun patch @x402/stellar` or keep the policy silent. The adapter object's typing has not been compiled
(UNVERIFIED).

### Q5. MPP on Stellar (deferred)

[`stellar/stellar-mpp-sdk`](https://github.com/stellar/stellar-mpp-sdk) is published as `@stellar/mpp` 0.7.1 (last
release 2026-07-02, repo pushed 2026-10-23). It began in the `stellar-experimental` org and implements MPP (Stripe/Tempo,
https://mpp.dev):

- **Charge** mode follows the IETF-style draft `draft-stellar-charge-00`: one SEP-41 transfer per request, pull or push,
  optionally fee-sponsored. It works with **no facilitator**.
- **Session/channel** mode uses the `stellar-experimental/one-way-channel` contract, which mpp.dev calls "experimental and
  has not been audited".

Docs: https://developers.stellar.org/docs/build/agentic-payments/mpp. The only hosted demo is `mpp.stellar.buzz`. It
needs `mppx` and **stellar-sdk ^15** (we need ^16 for x402 and 17 in the Worker), the spec is a draft, and smart-account
payers are not mentioned. x402 is what the Stellar docs, the facilitators and the sellers centre on. **Defer MPP;**
at most mention it as a second rail in the pitch.

### Q6. Froggy `packages/payments`: what carries over to Stellar

Chain-agnostic and reusable (adapt, do not copy):

- **Challenge decoding**:
  - `types.ts:66-89`: the `ChallengeResource` schema and `challengeResource()`, which echoes the seller's `resource`
    block back.
  - `types.ts:91-117`: the `PaymentChallenge` schema and `decodePaymentChallenge`. These are plain v2 `accepts[]` with
    string fields, and Stellar requirements fit unchanged.
  - Outside the four files, `wire.ts:59-92` (`challengeFrom`, header or body, 64 KiB bound) and `wire.ts:94-98` (sends
    the payment under both `payment-signature` and `x-payment`) are also agnostic.
- **Requirement selection**: `payer.ts:54-77`, `selectRequirements`, picks the first `network`+`exact` match rather than
  `accepts[0]`. Reuse it with `stellar:testnet`, plus an amount/asset allowance check before signing. Mind the
  `DEFAULT_TIMEOUT_SECONDS = 120` fallback at `payer.ts:52`: on Stellar, `maxTimeoutSeconds` sets the auth-entry
  expiration ledger, and the facilitator caps it.
- **Payload assembly**: `payer.ts:94-151`, `payerFromSigner`, wraps `scheme.createPaymentPayload` and attaches
  `accepted`, the echoed `resource`, and pass-through `extensions` (`payer.ts:115-135`). This is scheme-independent; swap
  `ExactHederaScheme` for our Stellar scheme. In 2.28.0, `x402Client.createPaymentPayload` does the same thing, so
  either works.
- **Header encoding** (`payer.ts:83-84`) and the interfaces `types.ts:120-134` (`Payer`, `PaymentAttempt`) and
  `types.ts:13-49` (`OracleGate`, `SettleOutcome` with `rejectedBeforeSubmission`) are chain-neutral.
- **Receipt handling**: `settlement.ts:30-65` encodes and decodes the `payment-response` envelope through
  `@x402/core/http`, with a bare-id fallback (`settlement.ts:53`) that also accepts 64-hex Stellar hashes. Reusable as is.
  The stub payer pattern (`payer.ts:245-277`, per-payment nonce at `261-268`) also carries over.

Not reusable:

- Hedera specifics: `payer.ts:79-81` (the `feePayer` decode; Stellar uses `areFeesSponsored`, which the server scheme
  injects), `payer.ts:172-232` (`TransferTransaction` signing), and `types.ts:136-144` (Hedera constants).
- `index.ts:1-111` is a barrel that also exports EVM, Solana, HCS and mirror modules. Only the probe/wire exports
  (`46-53`), settlement (`60`) and challenge types (`85-93`) matter here.
- **Idempotency: none of the four files implements it.** There is no payment-identifier and no dedup, only the stub
  nonce. Build it fresh on `@x402/extensions/payment-identifier`.

## (c) Recommended path for spike S2

1. **Facilitator**:
   - Claims 1–4 (G-account payer): `https://www.x402.org/facilitator`. No key; `/supported` is live with
     `areFeesSponsored: true`.
   - Smart-account payer (claim 5 / S5): the **in-process facilitator** from Q4 (`FACILITATOR=local`), with an
     XLM-funded G key from friendbot, `maxTransactionFeeStroops: 1_000_000`, and PR #3399 patched in if our account
     emits events.
   - Keep the OZ Channels testnet as a third option (generate a key at `/testnet/gen` and put it in `.env`; do not commit
     it).
2. **Accounts**:
   - Payer: G key → friendbot → USDC trustline (`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) → USDC from
     https://faucet.circle.com (Stellar testnet). `payTo`: a second G account with a trustline.
   - Smart account: send it USDC with a SAC `transfer` from the G account. Contracts need no trustline.
3. **Seller**: the Q4 file, run with `bun run`. Record the base64 `PAYMENT-REQUIRED` header.
4. **Classic client (claim 2)**:
   - Set up `createEd25519Signer(secret,"stellar:testnet")` →
     `new x402Client().register("stellar:*", new ExactStellarScheme(signer))` →
     `wrapFetchWithPayment(fetch, client)`.
   - Read the receipt with `new x402HTTPClient(client).getPaymentSettleResponse(h => res.headers.get(h))`.
   - For the dedup step: generate the id with `generatePaymentId()`, add it in an `onBeforePaymentCreation` hook with
     `appendPaymentIdentifierToExtensions`, and have the seller declare the extension and cache by id. Even without the
     cache, replaying the same payload cannot settle twice because the auth-entry nonce is consumed.
5. **Cap refusal (claim 3)**: `client.setSpendControls({ maxAmountPerPayment: "$0.05" })` refuses the $0.10 route before
   signing. The built-in default cap is `"$1"`, so 0.10 USDC passes by default.
6. **MCP (claim 4)**:
   - Server: `x402ResourceServer(fac).register("stellar:testnet", new ExactStellarScheme())`, then `await rs.initialize()`,
     then `accepts = await rs.buildPaymentRequirements({scheme:"exact",network:"stellar:testnet",payTo,price:"$0.10"})`.
     Register with `mcp.tool("quote", "…", schema, createPaymentWrapper(rs,{accepts})(handler))` over Streamable HTTP.
   - Client: `wrapMCPClientWithPayment(new Client(...), x402Client, { autoPayment: true, onPaymentRequested: allowanceCheck })`,
     then `callTool`. Log `params._meta["x402/payment"]` and `result._meta["x402/payment-response"]`.
7. **Smart-account payer (claim 5)**:
   - Write our own `SchemeNetworkClient`: copy the ~60 lines of the 2.28.0 client logic, changing only the signing call to
     `tx.signAuthEntries({ address: C…, expiration, authorizeEntry: (entry, _s, exp, pass) => authorizeEntry(entry, async (_pre, payload) => ({ signatureScVal: ourAuthPayload(payload) }), exp, pass) })`.
   - Use stellar-sdk 16.4.1. Its `authorizeEntry` (`lib/esm/base/auth.js`) passes `(preimage, payloadHash)` and honours
     `signatureScVal`.
   - The facilitator needs no changes beyond the event and fee issues above. The account's `__check_auth` must verify
     the connection key inline, must not call `require_auth` on other addresses, and should emit no events.
8. **S5 fallback question**: the exact-Stellar spec has **no verify-by-tx-hash mode**. The payload is always an
   unsubmitted transaction. "Submit ourselves, then show a receipt" only works with sellers we control.

## (d) Open risks, ranked

1. **C-address payers fail on hosted facilitators today.** Both x402.org (reference code 2.25–2.28) and OZ Channels reject
   any non-transfer contract event (#3352, #3764). x402.org also caps fees at 50k stroops, while an OZ smart account
   measured 290–324k (#3515).
   **"Pay any x402 seller from the smart account" does not hold for third-party sellers until PR #3399 merges and hosted
   ceilings rise.** Mitigation: the demo seller uses our facilitator; `__check_auth` emits no events and stays cheap;
   keep a G-account fallback lane for third-party sellers.
2. **The stock client cannot sign as a C-address** (#3158; PR #3860 unmerged). Low effort to fix with our own scheme
   class (step 7), but it is our code on the payment path.
3. **Facilitator uptime.** I have one probe each (x402.org 200/0.40 s; OZ 200/0.50 s with a key) and no SLA. OZ needs a key
   (it returns 401 otherwise). Vellar cold-starts in up to a minute. The public demo seller's last settlement was
   2026-10-17. Testnet resets wipe accounts. Mitigation: the in-process facilitator removes the dependency on hosted
   services; probe `/supported` at the start of the demo.
4. **Fee and expiration flakiness**: the 2-ledger expiration tolerance (#3168). The client derives expiration from
   `maxTimeoutSeconds` and the ledger-time estimate. Retry once on `signature_expiration_too_far`.
5. **SDK version split**: `@x402/stellar` and SAK need stellar-sdk ^16 (SAK: "do not install 17"), while S4 runs 17.3.0
   in the Worker. Keep x402 signing on 16.4.1 in its own package, or confirm Bun resolves two copies; mixing XDR objects
   across copies breaks `instanceof`.
6. **Stellar over MCP is untested upstream** (no e2e); the `-32042` workaround depends on the MCP SDK version (test 1.32.2).
7. **Minor**: `areFeesSponsored:false` is unsupported (#3333). `@x402/core` pins zod 3, with an advisory (#3914). Neither
   facilitator advertises `payment-identifier`, so dedup is only server-side.
