# Nod MCP OAuth audit — 27 October 2026

OAuth fixes are verified in unit tests and local workerd. **These changes have not been deployed.** Testnet and
mainnet reported release `a663158f28a4855256c67b3a81ff4e5f0c18629b` during the baseline. The authorized delivery session
owns deployment; mainnet requires the owner's explicit go after testnet passes.

The audit follows MCP **2026-07-28**, Basic / Authorization, and the same 41 requirements as the 25 October
cross-application audit. The official suite is `modelcontextprotocol/conformance` at `c37eec88`
(`0.2.0-alpha.12`). It tests authorization-server behavior; separate probes cover the protected MCP resource.

## Changes and decisions

- DCR returns the supported subset of `grant_types`, rejecting an empty subset or inconsistent response types.
  The minimal Bun patch follows [workers-oauth-provider#422](https://github.com/cloudflare/workers-oauth-provider/issues/422).
  Patch files are included in Alchemy's build inputs.
- Every listed DCR callback must use HTTPS or HTTP loopback, even in a mixed list. This uses the provider's
  registration-policy callback after its syntax checks. Actual CIMD callback validation stays with the provider.
- Access-token TTL is 900 seconds. The provider already issues refresh tokens without `offline_access`;
  a `wallet`-only signed flow verifies that behavior. PRM and resource challenges continue to name only `wallet`.
- `/mcp` checks the authoritative D1 connection before serving any MCP operation, including tool/resource discovery.
  A revoked, missing or mismatched connection returns 401 `invalid_token`, even if provider-token cleanup failed.
  A valid connection without `wallet` scope returns 403 `insufficient_scope` with scope and resource metadata.
- Unknown `/.well-known/*` documents return 404 after supported OAuth discovery and `stellar.toml` have been handled.
- CIMD remains primary, with DCR retained pending real-client acceptance. DPoP is absent. Add it only as a complete
  implementation with proof checks at every resource server once the MCP extension is stable.

The existing `OAUTH_STORE` Durable Object is the provider's authoritative client/grant/token store. The provider
writes those records. D1 owns connection revocation, written by the wallet ledger; encrypted OAuth props are a
consent-time snapshot and cannot override the current connection row. No store or migration was added.

`apps/seller` exposes x402-paid MCP tools, without a user-authorized OAuth server. It is outside this OAuth lane.
No HTTP guard was added: both deployed hosts already return edge HTTP 301 and one-year HSTS.

## Requirement matrix

**Before** means testnet wire evidence where available, otherwise explicitly marked source inspection. Mainnet
was read-only: discovery, missing/forged bearer rejection, HTTPS/HSTS and CORS were checked; no registration,
signed-in flow or revocation was attempted there. Mainnet discovery matched testnet. **After** means local workerd
or unit proof, never a claim that a fix is already live. `U` is a regression test; `L` is local workerd.

| # | Requirement | Before | After / proof |
| --- | --- | --- | --- |
| 1 | PRM at an allowed well-known path | Pass: path-inserted `/mcp`; root 404 is valid | Preserved, L |
| 2 | PRM resource and nonempty authorization servers | Pass: canonical MCP URL and issuer | Preserved, L |
| 3 | No token: 401 + Bearer resource metadata | Pass on both live stages | Preserved, L |
| 4 | Challenge carries scope | Pass: `wallet` | Preserved, L |
| 5 | No `offline_access` in PRM/challenge | Pass | Preserved, L; refresh still issued |
| 6 | Garbage/forged token: 401 `invalid_token` | Pass on both live stages | Preserved, L |
| 7 | AS discovery and identical issuer | OAuth document passed; OIDC URL returned SPA HTML | OAuth preserved; OIDC 404, L |
| 8 | OIDC discovery includes PKCE when served | N/A: no OIDC server | Explicit 404, L |
| 9 | Official AS metadata scenario | 2/2 on testnet and mainnet | 2/2 local |
| 10 | HTTPS-only deployed endpoints | Pass: edge 301; HSTS 31536000 including subdomains | Unchanged; loopback HTTP is intentional locally |
| 11 | S256 only; absent/plain PKCE refused | Pass: error redirects, no code | Preserved, L |
| 12 | CIMD supported and advertised | Pass | Preserved, source + L metadata |
| 13 | Real-client CIMD interoperability | Claude web, ChatGPT, Codex and VS Code reached authorization pages | No changes; vendor GUI/token acceptance unverified |
| 14 | CIMD validation and bounded SSRF | Source: provider URL/document validation and `global_fetch_strictly_public`; invalid host refused live | Unchanged; no new fetch implementation |
| 15 | Consent shows redirect hostname | Pass for varied loopback port; warning confirmed in source | L screenshot and browser assertion confirm host and warning |
| 16 | Claude Code DCR shape without application type | Pass | Preserved, U + L |
| 17 | IPv4/IPv6 loopback and HTTPS DCR | Pass | Preserved, U + L |
| 18 | Non-loopback HTTP redirect refused | Single URI refused; mixed HTTPS/HTTP list accepted | Entire mixed list refused, U + L |
| 19 | Extra DCR grant types narrowed | Failed: any unsupported grant rejected | Supported subset returned and stored, U + L |
| 20 | VS Code mixed loopback/HTTPS plus device grant | Failed DCR; CIMD authorization worked | DCR narrowed successfully, U |
| 21 | Custom schemes refused | Single custom URI refused; mixed list accepted (actual custom redirect still refused by provider) | Mixed DCR list also refused, U + L |
| 22 | Unknown client/unregistered redirect never redirects | Pass: 400 page | Preserved, L |
| 23 | Loopback IP port variance, exact path | Pass: changed port 200; changed path 400 | Unchanged provider; L port + source |
| 24 | Resource validation/default | Pass: foreign rejected; absent defaults to `/mcp` | Preserved, L; foreign refresh target also rejected |
| 25 | Uppercase scheme/host resource normalization | Pass on testnet | Unchanged provider |
| 26 | RFC 9207 `iss`, advertised when sent | Pass, including error redirect | Official local authorization-code check passes |
| 27 | State echo; JSON/no-store token replies | Error replies passed; successful flow not run live | Official local code flow and token responses pass |
| 28 | Access-token audience binding | Source: opaque token record bound to resource | L accepted at its origin and refused at another local origin sharing the store |
| 29 | Wrong issuer/audience rejected | Forged token refused live; valid cross-issuer token not tested live | L wrong-origin audience 401 |
| 30 | No token passthrough | Source: MCP bearer authenticates Nod; downstream payment credentials are separate | Unchanged |
| 31 | Query-string token not accepted | Source: Authorization-header-only parser | L 401 |
| 32 | Public-client refresh rotation | Source: rotates, retains one previous token | L rotation confirmed; previous token remains accepted |
| 33 | Refresh replay revokes family (BCP) | Not implemented by provider | **Known limitation retained**, see below |
| 34 | Short access-token lifetime | Source: 3600 seconds | L token response `expires_in: 900` |
| 35 | Unknown revoke token returns 200 | Pass on testnet | Preserved, L |
| 36 | Revoke ends existing access tokens | Source: provider deletes tokens; owner cleanup failures were swallowed | L RFC 7009 and owner revoke deny access immediately; U covers surviving provider token |
| 37 | Invalid/revoked token gets 401 | Provider 401; stale props lacked challenge; failed cleanup could leave connection readable | U old/missing/mismatched/revoked props: 401 `invalid_token`; L revoke passes |
| 38 | Insufficient scope: 403 + scope + metadata | Source/U reproduction: scope was advertised but not enforced | U 403 `insufficient_scope`; revoked takes priority over scope |
| 39 | DPoP advertisement matches implementation | Not advertised; no binding | Plain Bearer; official DPoP checks skipped; L DPoP scheme refused |
| 40 | Browser CORS on metadata/token | Both live stages: metadata 200 and token OPTIONS 204; required headers exposed | Unchanged provider |
| 41 | Official full authorization-code / DPoP suite | Signed-in live suite not run | L metadata 2 + code 1 pass; DPoP 3 checks skipped, exit 0 |

**Refresh replay limitation:** provider 1.2.4 rotates credentials but accepts the immediately previous refresh token
without a timed window. Older unretained tokens fail without family revocation. The vrials audit permitted retaining
this provider policy, which is retained here too. This is not a claim of complete refresh-replay protection. A provider-owned
atomic replay/family-revocation change remains a follow-up; no application compatibility shim was added.

## Evidence

- `before-testnet.json`, `before-testnet-extra.json`, `before-supplement.json`: testnet discovery, DCR, invalid
  authorization/token requests, real-client CIMD pages, mixed redirect-list observations and deployed release.
- `before-mainnet.json`, `cors.json`: read-only mainnet/testnet discovery, transport and browser headers.
- `after-local.json`: the same baseline probe against workerd. Its four "not https" findings are the deliberate
  localhost HTTP exception; they do not describe either deployed host.
- `local-flow.json`: 36 successful checks through real workerd, Chrome virtual WebAuthn, the actual OAuth provider
  and local fixture chain. Two `wallet`-only token replies have 900-second expiry and refresh tokens. The fixture
  chain does not prove onchain behavior, and no payments or paid providers were invoked.
- `conformance.json`: official check records for both deployed metadata endpoints and the full local suite.
  Codes, state, PKCE values and tokens are redacted, including the suite's partial token previews.
- `smoke-local.json`: repository HTTP acceptance, 9/9 passed.
- `cleanup-testnet.json`: eight exact audit client IDs deleted; zero matching clients, grants or tokens remain.
  Unsigned consent transactions are encrypted and expire in 600 seconds; expired physical rows were not purged.

Before the fixes, the new DCR test failed with 400 instead of 201. The new MCP scope/revocation tests failed with
200 instead of 403/401, and obsolete props lacked an auth challenge. Afterward all passed. Independent
`thermo-nuclear-review` found no introduced security/correctness findings; targeted OAuth/provider/consent tests passed.
The full gate also passes format, agent/card/skill drift, lint, typecheck, tests, Rust clippy/tests and build. Later
integration-gate and CI details are in the worker receipt.

The first running local process still held the provider bundle loaded before the Bun patch. Restarting `bun run dev`
loaded the patched dependency and the complete flow passed. Restart after applying dependency patches; hot source reload
is not proof that the new dependency was bundled.

## Reproduce and deploy handoff

From an installed checkout, run `heavy --wait bun run check`. Start `bun run dev`, then `bun run smoke:local`.
The regression files are `apps/web/src/server/oauth-provider.test.ts`, `oauth.test.ts` and `consent.test.ts`.
Connect a remote MCP client to `http://localhost:18960/mcp`, create a fixture wallet with a passkey and approve consent.
Request only `wallet`: the token must be Bearer, expire in 900 seconds and include a refresh token. Revoke the connection
on Nod; the old bearer must immediately receive 401 with `error="invalid_token"`.

The delivery session should install with the lockfile, run the full gate in its authorized deployment checkout,
inspect its normal testnet plan and deploy according to `docs/DEPLOY.md`. No binding or migration change is expected.
After deployment, read health for the pinned release, run the repository testnet smoke, repeat the OAuth flow and
remove any new testnet audit clients. Check that AS/PRM documents remain unchanged except for the origin, OIDC/unknown
well-known paths return 404, `stellar.toml` still returns 200, DCR extra grants return 201 with the supported subset,
and mixed custom/remote-HTTP callbacks return 400. TTL is visible in the token response, not discovery metadata.

No deployment, plan, production mutation, upstream issue comment or PR change was performed. No PR was named for
closure. Keep DCR until vendor connector acceptance is confirmed, including ChatGPT's `private_key_jwt` token step.
