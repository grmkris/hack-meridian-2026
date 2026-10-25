# Research: HackMeridian submission, CAP-73, CCTP, MCP hosts, Raven

Checked 2026-10-25 10:55–11:50 UTC. Sources are linked inline. Anything marked **UNVERIFIED** was not confirmed from
a primary source or was not executed. Testnet facts marked **VERIFIED (testnet)** were run with `stellar` 28.1.0
against `soroban-testnet.stellar.org`, using throwaway keys in `/tmp/hm-research/stellarcfg` (no repo files touched).

## (a) Submission checklist

**Deadline: 2026-10-26T12:00:00Z** (Mon 26 Oct 12:00 Lisbon). Portugal left DST at 01:00 UTC on Sun 25 Oct, so
Lisbon is WET = UTC+0 for the deadline (checked with tzdata). "No late submissions." Judging is 13:00–14:45 Lisbon,
finalists are picked by 15:30, and finalists pitch live at Meridian on Wed 28 Oct at 13:50.
Sources: [hackmeridian.com](https://www.hackmeridian.com/), [/build](https://www.hackmeridian.com/build),
[/faq](https://www.hackmeridian.com/faq), [/schedule](https://www.hackmeridian.com/schedule).

**Where to submit:** the builder portal [app.hackmeridian.com](https://app.hackmeridian.com) (sign in with the
registered email). You also pick the path (Genesis/Scale) there. The form sits behind login, so its fields, the video
length limit and the deck format are **UNVERIFIED**. No public page states them.

| #   | Item                                                                                                                                                             | Est. time                                 | Notes                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Now:** sign in to the portal, open the submission form, copy the exact questions and limits into `docs/`                                                       | 15 min                                    | Removes every UNVERIFIED in this table. Confirm the team and the Genesis path                                                                       |
| 1   | Public GitHub repo with commit history from the event                                                                                                            | 10 min now, then ongoing                  | The repo has **zero commits** right now. "Hackathon Progress" (10%) asks "Can you clearly demonstrate what you built or improved during the event?" |
| 2   | README: problem, how it works, **specs**, architecture, testnet contract IDs, tx explorer links, how to run, how judges can test, prior work, and AI attribution | 60–90 min                                 | The site says: "A clear README that shows how your project works, including its specs, does most of the work for judges"                            |
| 3   | Demo video                                                                                                                                                       | 90–120 min (script, record, edit, upload) | Length limit **UNVERIFIED**. Plan for ≤ 3 min unless the form says otherwise                                                                        |
| 4   | Pitch deck                                                                                                                                                       | 60–90 min                                 | Format **UNVERIFIED**. Export a PDF (8–10 slides), one slide per rubric line                                                                        |
| 5   | Submission answers                                                                                                                                               | 30 min                                    | Questions not published (**UNVERIFIED**)                                                                                                            |
| 6   | A live, judge-testable deployment (URL + funded testnet path)                                                                                                    | 30 min to verify                          | Checklist line: "Does your core feature work, and can judges test it?"                                                                              |
| 7   | Submit, then re-check every link in a private window                                                                                                             | 20 min                                    | Target 11:00 UTC. Keep 60 min of buffer                                                                                                             |

That is about 5–6 h of submission work. `docs/SPIKES.md` gives it 08:00–11:45 UTC (3 h 45), so start the README and
deck skeleton earlier.

## (b) Findings

### 1. HackMeridian 2026 rules

- **Judged material:** "async review of the demo video, pitch deck, GitHub repo, and submission answers. Live pitches
  are only for finalists." The order of priority is "Adoption → Discovery → Continuation".
- **Rubric** (each criterion scored 1–5): Track Alignment 20%, User Value & Problem 20%, Technical Execution 15%,
  Innovation 15%, Hackathon Progress 10%, Market & Ecosystem Potential 10%, Product Design & UX 10%. Genesis is judged on
  "Problem clarity, MVP quality, Stellar integration, Continued development potential" (Idea → MVP).
- **Genesis vs Scale:** Genesis is for "a new idea, early prototype". Scale is for "an existing product or advanced
  prototype" and is scored on milestones set at a pre-event intake, SCF eligibility, production readiness and ecosystem
  impact. Scale projects pick no track.
- **Both tracks: YES.** "A Genesis project can be part of both tracks (Unlocked and Composed)." Track Alignment scores
  "fit with Stellar Unlocked and/or Stellar Composed".
  - Composed: "combines two or more ecosystem tools or projects". Its first example idea matches our product almost
    word for word: "Agents that spend: Give an agent a wallet…, set its limits with OpenZeppelin's policy library, and let
    it pay for APIs in stablecoins… over x402 or MPP." It also lists CCTP under "Bring users and liquidity to Stellar".
  - Unlocked lists "**Create trustlines through SACs**" by name under "The underrated toolbox".
- **Pre-existing code and own libraries:** no explicit rule is published (**UNVERIFIED**). The Terms (§05, §06) forbid
  "plagiarize, or misrepresent your work" and say you own your work "subject to any third-party or open-source
  licenses". Genesis allows an "early prototype". Recommendation: list prior work and own libraries in the README, and
  let the commit history show what was built during the event ([terms](https://www.hackmeridian.com/terms.html)).
- **Team:** solo or up to 5. In person only. 18+. AI is allowed. The portal says "AI tools are encouraged — just
  attribute them."
- **Testnet vs mainnet:** no rule (**UNVERIFIED**). The signals point both ways: Composed asks for "real infrastructure
  that keeps running long after demo day" and notes USDC/USDT0 are "live on Stellar mainnet", and there is a "How to
  prepare to go live on Mainnet" workshop. But the tracks also accept testnet-only tools (SPP). Testnet looks
  acceptable. A small mainnet proof would help Adoption.
- **Prizes:** $30,000 across 6 winners, paid in XLM. The "$50k" figure that circulates belongs to 2024
  ([Stellar-Light PR #1838](https://github.com/Stellar-Light/stellarlight/pull/1838)).

### 2. CAP-73 (Protocol 26) and the SAC `trust` function

- **Spec:** [CAP-0073](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0073.md), status Final,
  protocol 26. It went to testnet on 2026-04-16 and mainnet on 2026-05-06
  ([software versions](https://developers.stellar.org/docs/networks/software-versions)).
- **Live now:** testnet and mainnet both run protocol 29, with core 30.0.0 (RPC `getNetwork` and Horizon root, queried at 11:21 UTC).
  Protocol 29 was a security-only release. No P30 or testnet reset is listed for this week.
- **Signature (as implemented):** `fn trust(env: Env, addr: Address)`. The parameter is **`addr`**, not `address` (the
  CAP text says `address`). soroban-sdk **29.0.1** has `trust` on
  [`token::StellarAssetInterface`](https://docs.rs/soroban-sdk/latest/soroban_sdk/token/trait.StellarAssetInterface.html).
  It is a no-op for C-addresses and for an existing trustline. It creates an `i64::MAX`-limit trustline and emits **no
  event**.
- **Who authorizes:** `addr.require_auth()` runs **only if a trustline is actually created**, so the trustline owner's
  G account must sign. Nobody else can create the trustline. **VERIFIED (testnet)**: with alice as source and bob as
  `addr`, stellar-cli attached bob's address-credential auth entry and the call succeeded
  ([tx 6cdd4728…](https://stellar.expert/explorer/testnet/tx/6cdd472809602437f95327c80cef5368291e839edbf1abca55b2d583de1334a4)).
  A self-call also worked ([tx 757025ce…](https://stellar.expert/explorer/testnet/tx/757025ce42cf36e8337cb819c934bf33fe289d681ebdeffc7696cd9513578181)).
- **Reserve: YES, the account needs +0.5 XLM free, and sponsorship is not supported.** **VERIFIED (testnet):** an account
  holding exactly 1.0 XLM failed with `Error(Contract, #14) "account has insufficient reserve for new trustline"`.
  At 1.5 XLM it succeeded (fees were paid by a different source). The classic rules still apply: the asset must
  be authorized for the holder. Testnet USDC issuer `GBBD47…FLA5` has `auth_required: false`.
- **XLM SAC transfer creates accounts:** YES, for `transfer`/`transfer_from` of native XLM to a missing G (or to the G inside an
  M address), if amount ≥ the minimum balance (1 XLM = 10,000,000 stroops). **VERIFIED (testnet):**
  0.9999999 XLM → `Error(Contract, #14) "transfer amount is below minimum balance for new account"`, while 1 XLM created
  the account. The new account can authorize (`require_auth`) in the same invocation (per the CAP; **UNVERIFIED** end to end).
- **stellar-cli** (testnet USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, XLM SAC
  `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`):
  ```sh
  stellar contract invoke --id $USDC_SAC --source relayer --network testnet -- trust --addr $RECIPIENT_G
  stellar contract invoke --id $XLM_SAC --source alice --network testnet -- transfer --from $A --to $NEW_G --amount 15000000
  ```
  If `$RECIPIENT_G` is a stellar-cli identity, the CLI signs its auth entry automatically. Otherwise use `--build-only`
  and sign the auth entry elsewhere.
- **@stellar/stellar-sdk** sketch (**UNVERIFIED**, not executed; uses the v16/v17 API):
  ```ts
  const op = new Contract(USDC_SAC).call('trust', new Address(recipientG).toScVal())
  let tx = new TransactionBuilder(await server.getAccount(relayer.publicKey()), {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(tx) // recording mode → sim.result.auth = [recipient entry]
  const until = (await server.getLatestLedger()).sequence + 60
  const signed = await Promise.all(
    sim.result!.auth.map(e => authorizeEntry(e, recipientKpOrCallback, until, Networks.TESTNET)),
  )
  // rebuild with Operation.invokeHostFunction({ func: op.body().invokeHostFunctionOp().hostFunction(), auth: signed }),
  // re-simulate (enforcing), rpc.assembleTransaction, relayer signs the envelope, sendTransaction.
  ```
  A wallet can use `signAuthEntry` for the recipient instead of a raw keypair (Freighter, Wallets Kit). Support for
  `contract.Client.from()` on a SAC (no Wasm spec) is **UNVERIFIED**, so prefer `Contract.call`.
- **Router with two authorizers: YES in principle.** It is not built here; S3 owns that test.
  `router.pay_and_trust(token, sender, recipient, amount)` calls `StellarAssetClient::trust(&recipient)` then
  `TokenClient::transfer(&sender, &recipient, &amount)`. According to the
  [authorization docs](https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization),
  each address's auth tree is "condensed" to the calls that `require_auth` for it, and "these trees don't have to have
  their root be … the top-level contract call". So:
  - The recipient signs a tree whose root is `SAC.trust(recipient)`.
  - The sender signs `SAC.transfer(sender, recipient, amount)`. If the router also calls `sender.require_auth()`, the
    sender signs `router.pay_and_trust(...)` with `SAC.transfer` beneath it.
  - Both entries go in the one `InvokeHostFunction` op. The relayer is the tx source and pays fees.
  - Pitfalls:
    - (i) `trust` asks for auth only when it creates the trustline. Simulate first, because if the trustline exists the
      recipient entry is not needed. Whether an extra unused entry fails the tx is **UNVERIFIED**.
    - (ii) The direct invoker is auto-authorized ("but not any calls on behalf of the contract deeper down the stack").
      You need `env.authorize_as_current_contract(...)` only if the router's own address is the `from` of a call two or
      more frames down (router → X → SAC). The plain design does not need it.
    - (iii) A sender that is an OZ smart account sees whichever root you choose in `__check_auth` contexts. Pick the
      root its spending-limit policy expects (S1).
    - (iv) The recipient's reserve: a router can first do `XLM_SAC.transfer(sender, recipient, 5_000_000)` (or ≥ 1 XLM
      to create the account) in the same invocation.
  - **Product consequence:** a saved contact who is not online cannot be onboarded. Their key must sign the `trust`
    entry. Use a claim link (the recipient signs with their wallet), or pay contacts who have no trustline to a C-address
    or escrow.

### 3. Circle CCTP on Stellar

- **Testnet: supported**, with Stellar as **domain 27** and Arc testnet as domain 26
  ([domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains),
  [CCTP on Stellar](https://developers.circle.com/cctp/references/stellar)). Stellar only supports Standard Transfer as
  a source, and the Forwarding Service is not available.
- **Quickstart (Stellar Testnet ↔ Arc Testnet):**
  <https://developers.circle.com/cctp/quickstarts/transfer-usdc-stellar-arc>. It needs Node ≥ 22.18,
  `@stellar/stellar-sdk` and `viem`, and covers both directions.
- **Testnet IDs** ([contracts](https://developers.circle.com/cctp/references/stellar-contracts)):
  TokenMessengerMinter `CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP`, MessageTransmitter
  `CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY`, CctpForwarder
  `CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ`, USDC `CBIELTK6…DAMA`. Arc testnet: USDC
  `0x3600000000000000000000000000000000000000`, TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`,
  MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`.
- **Sending to a C-address** (our smart account) with `depositForBurnWithHook(amount, 27, forwarderBytes32,
  ARC_USDC, forwarderBytes32, maxFee, 2000, hookData)`:
  - Set **mintRecipient = destinationCaller = CctpForwarder**, from `StrKey.decodeContract`.
  - Build hookData as 24 zero bytes, then uint32 version 0, then the uint32 strkey length, then the strkey as UTF-8.
  - `C…` recipients are allowed and need no trustline. G/M recipients do need a trustline.
  - On Stellar, call `CctpForwarder.mint_and_forward(message, attestation)`. The docs place no caller restriction, so
    our relayer can submit it.
  - A wrong destinationCaller or mintRecipient leaves the funds "permanently stuck".
  - Amounts: CCTP uses 6 decimals and Stellar USDC uses 7.
- **Attestation latency:** about 0.5 s for Arc and about 5 s for Stellar, both Standard
  ([finality](https://developers.circle.com/cctp/concepts/finality-and-block-confirmations)). The quickstart still says to
  expect "several minutes" on the sandbox. Poll `https://iris-api-sandbox.circle.com/v2/messages/{srcDomain}?transactionHash=`
  (limit 40 req/s). Real testnet latency is **UNVERIFIED**.
- **Faucet:** [faucet.circle.com](https://faucet.circle.com) lists **Arc Testnet** and **Stellar Testnet**, at 20 USDC
  per address per chain every 2 h. Arc gas is paid in USDC.
- **Estimate for a one-direction spike (Arc → our C-account):** 3–4 h, made of 1.5 h to adapt the quickstart script and
  get one mint, 1 h to wrap it as an MCP tool or UI button with polling, and 0.5–1 h of slack for attestation waits.
- **Circle Gateway does not support Stellar.** Its [supported list](https://developers.circle.com/gateway/references/supported-blockchains)
  has 13 chains, all EVM plus Solana.

### 4. MCP hosts

**a. ChatGPT** (custom MCP servers live under "plugins"; the old name was Apps):

- **OAuth** ([auth doc](https://developers.openai.com/apps-sdk/build/auth)):
  - Needs RFC 9728 protected-resource metadata, AS metadata, and PKCE with `S256` (required).
  - Client registration options are CIMD (preferred), DCR, or a static client.
  - Redirect URI: `https://chatgpt.com/connector/oauth/{callback_id}`, or `https://chatgpt.com/connector_platform_oauth_redirect`
    when you return RFC 9207 `iss`.
  - It sends the `resource` parameter, and you must check `aud`.
- **Usage policy line** ([submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)): under
  "Prohibited fraudulent, deceptive, or high-risk services" it lists **"Execution of money transfers, crypto transfers,
  or investment trades"**. That rule governs published plugins, and whether it is enforced on a private developer-mode
  connector is **UNVERIFIED**.
- **Plan gating** is inconsistent: the help center says full write-capable MCP is Business/Enterprise/Edu only, while
  the dev docs say Plus/Pro too (**UNVERIFIED**; the [help article](https://help.openai.com/en/articles/12584461) returned
  403 to us).
- **MCP Apps** (`ui://` + `_meta.ui.resourceUri`) are supported natively, with ChatGPT-specific extensions on top. Web
  only. Agent mode does not use custom MCP apps
  ([Scott Logic](https://blog.scottlogic.com/2026/09/16/mcp-apps-your-ui-their-chat.html), secondary source).

**b. Claude** ([build](https://claude.com/docs/connectors/building/index.md),
[auth](https://claude.com/docs/connectors/building/authentication.md),
[custom connector](https://claude.com/docs/connectors/custom/remote-mcp)):

- Supports the 2025-03-26, 2025-06-18 and 2025-11-25 auth specs.
- **DCR is not required.** Options are CIMD ("Use Claude's published identity"; the AS must advertise
  `client_id_metadata_document_supported: true` **and** `none` in `token_endpoint_auth_methods_supported`), DCR, or
  **"Use your own OAuth client" (static client id, secret optional)**.
- PKCE S256 always.
- It needs a `401` with a `WWW-Authenticate: Bearer resource_metadata=…` header and only uses the first entry of
  `authorization_servers`. It gives 10 s per OAuth endpoint.
- Callbacks: `https://claude.ai/api/mcp/auth_callback` for web, Desktop and mobile, and also allowlist
  `https://claude.com/api/mcp/auth_callback`. Claude Code uses a loopback `http://localhost:PORT/callback` (match both
  `localhost` and `127.0.0.1` on any port), or `--client-id`/`--callback-port`.
- Custom connectors work on Free (1 connector), Pro, Max, and Team/Enterprise (added by an Owner).
- Limits: 240 s per tool call and about 150k characters per result on hosted surfaces.
- **MCP Apps:** supported in claude.ai and Desktop. Claude Code ignores `ui://` resources.
- **Elicitation:** Claude Code supports form **and URL mode** ("asks whether to open a link in your browser"). On
  revision 2026-07-28 it declares `elicitation: {form: {}, url: {}}` ([Claude Code MCP](https://code.claude.com/docs/en/mcp)).
  The hosted claude.ai docs do not list elicitation among supported features, so it is **UNVERIFIED** there. Return the
  approval link in the tool result text as well.

**c. [openai/mcp-extensions](https://github.com/openai/mcp-extensions):** OpenAI's spec plus SDKs extending MCP and MCP
Apps with ChatGPT-only capabilities (message, modelContext, files, `openai/resources/write`). TypeScript is
`@openai/mcp-extensions` 0.2.1 (2026-10-21) and Python is `openai-mcp-extensions`. The repo was created on 2026-09-29,
has about 1.1k stars and is actively pushed. It is optional, and we don't need it unless we target ChatGPT-specific UI.

**d. OAuth on Cloudflare Workers:**

- `@cloudflare/workers-oauth-provider` **1.2.4** (2026-10-22; 1.0.0 shipped 2026-09-24; the repo was pushed
  2026-10-22, so it is maintained). It needs a KV binding, and gives you `/authorize`, `/token`, `/register` (DCR), PKCE,
  and grant `props` that reach the API handler.
- `agents` **0.30.1** (2026-10-23) exports `agents/mcp`, with `McpAgent` (Durable Object, stateful) and a stateless handler.
- **Proof it works with Claude:** Raven ([stellar-experimental/stellar-raven](https://github.com/stellar-experimental/stellar-raven))
  runs on `workers-oauth-provider` ^0.10.3 + `agents` 0.28.1. Its live AS metadata advertises `registration_endpoint`,
  `client_id_metadata_document_supported: true`, `S256`, and `none|client_secret_basic|client_secret_post`. That covers
  Claude (CIMD or DCR) and ChatGPT.
- **@stellar/stellar-sdk on workerd:**
  - 16.4.1 (the repo's version) defaults to a **fetch** HTTP client (`lib/cjs/http-client/index.js` → `fetch-client`),
    but still needs `Buffer`, so it needs `nodejs_compat`. `apps/web/alchemy.run.ts` already sets that flag.
  - 17.3.0 drops `buffer`.
  - Avoid the `@stellar/stellar-sdk/axios` entry. axios 1.20.0's fetch adapter threw "Unsupported cache mode" on
    Workers ([axios#11192](https://github.com/axios/axios/issues/11192), now closed).
  - Horizon `.stream()` is a poor fit for Workers. Poll RPC instead.

### 5. Raven, the Stellar docs MCP server, and skills

- **Raven:** `https://raven.stellar.org/mcp` (streamable HTTP; canonical since 2026-08-04). `raven.stellar.buzz/mcp`
  still answers, and both return 401 with RFC 9728 metadata. Auth is OAuth: the Worker is its own AS, and sign-in goes
  through WorkOS AuthKit. No API keys.
  ```sh
  claude mcp add --transport http stellar-raven https://raven.stellar.org/mcp   # then /mcp → Authenticate
  ```
  As a `.mcp.json` entry: `{"mcpServers":{"stellar-raven":{"type":"http","url":"https://raven.stellar.org/mcp"}}}`
  ([raven.stellar.org](https://raven.stellar.org/)).
- **Docs-only, no sign-in:** `https://developers.stellar.org/mcp` answered `initialize` with 200 and no auth
  ([stellar-docs PR #2947](https://github.com/stellar/stellar-docs/pull/2947)). Add it with
  `claude mcp add --transport http stellar-docs https://developers.stellar.org/mcp`.
- **Skills** ([stellar/stellar-dev-skill](https://github.com/stellar/stellar-dev-skill), served at skills.stellar.org,
  HEAD `e20f352`, 2026-10-21):
  - The plugin manifest is `{"skills": "./skills/"}` with **no hooks and no settings**.
  - The skills are `skills/{agentic-payments,assets,cross-chain,dapp,data,smart-contracts,standards,zk-proofs}/`. Each
    has a SKILL.md, and some have companion `.md` files.
  - To vendor only the skills, without plugin install and without touching settings:
  ```sh
  t=$(mktemp -d) && git clone -q --depth 1 https://github.com/stellar/stellar-dev-skill "$t" \
    && mkdir -p .claude/skills && cp -R "$t"/skills/* .claude/skills/ && rm -rf "$t"
  ```
  Keep the directory names, because frontmatter `name:` equals the directory name.

## (c) Recommendations

1. **Demo host: Claude (claude.ai custom connector, or Claude Desktop for MCP Apps), with Claude Code as backup.**
   - Claude is documented to accept CIMD, DCR or a static client id.
   - It renders MCP Apps.
   - It carries no money-transfer prohibition like ChatGPT's.
   - Claude Code supports URL-mode elicitation for the approval link.
   - Use ChatGPT only as a cameo, and only if the account has developer-mode write actions. Its published policy
     prohibits "Execution of money transfers, crypto transfers", which is a bad look on video and a plan-gating risk.
   - Goblin stays the fallback we control.
2. **OAuth:** use `@cloudflare/workers-oauth-provider` 1.2.4 + `@modelcontextprotocol/sdk` (stateless) or `agents/mcp`,
   and copy Raven's layout.
   - Advertise DCR **and** CIMD (`client_id_metadata_document_supported: true`, `none` auth method), S256, and
     `offline_access`. Return 401 with `resource_metadata`.
   - Put the per-connection grant (session-key id, allowance, expiry) in the OAuth grant `props`. The `/authorize`
     consent page is where the passkey signs the onchain allowance.
   - Do not hand-roll OAuth 2.1 in 20 h, unless S4 shows that porting Sidequest's existing Effect implementation is
     faster.
3. **CAP-73:** worth building because Unlocked names it.
   - Design it as a **claim link**: the recipient signs the `trust` auth entry, and the sender's transfer plus an XLM
     reserve top-up go in the same router call.
   - Do not promise "pay any G address silently".
4. **CCTP spike:** only after S1–S4 are green, as `docs/SPIKES.md` already says. It costs 3–4 h for one direction
   (Arc → our C-account), which suits Composed. Skip it if the core demo is not rehearsed by about 04:00 UTC.
5. **Submission:** open the portal form now (item 0) and commit a baseline today. Map the deck one-to-one onto the
   7-line rubric. Name both tracks explicitly in the README and the answers.

## (d) Open risks

- **Submission form limits are unknown** (video length, deck format, questions): UNVERIFIED until someone logs in.
- **Recipient-signature requirement for `trust`** means a contact who isn't present cannot be onboarded. The UX needs a
  claim step, and the recipient also needs ≥ 0.5 XLM of free reserve (top it up in the same router call).
- **Unused auth entries:** if the trustline already exists, a pre-signed recipient entry is unused. Whether that fails
  is UNVERIFIED, so always re-simulate before submitting.
- **ChatGPT:** policy prohibition, unclear plan gating for write actions, and community reports of connectors
  disappearing.
- **claude.ai elicitation support** is undocumented. Fall back to a link in the tool result.
- **CCTP sandbox attestation** can take minutes, which puts a live demo at risk. Pre-record it or pre-burn it.
- **Testnet:** no reset or upgrade is scheduled for this week (P29, core 30.0.0 already deployed), but this is not
  guaranteed. Keep the redeploy scripts ready.
- **Repo hygiene:** zero commits so far, which hurts "Hackathon Progress" evidence. Also,
  `spikes/s3/.env` exists and must not be committed if it holds keys.
