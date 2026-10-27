# Nod MCP OAuth conformance — 2026-10-27

This evidence records the Nod MCP OAuth audit and local verification. Live testnet probes used throwaway registrations only;
mainnet probes were read-only. Tokens and secrets are not recorded.

## Matrix

| Requirement | Testnet before | Mainnet before | Source after | Local workerd after |
| --- | --- | --- | --- | --- |
| MCP 401 challenge and invalid bearer | 401; invalid token had `error="invalid_token"` | 401; invalid token had `error="invalid_token"` | Preserved; MCP entry point now returns the same shape for revoked D1 connections | Pass |
| Protected Resource Metadata and CORS | 200; browser origin allowed | 200; browser origin allowed | Preserved | Pass |
| Authorization Server metadata and CIMD | 2/2 official checks; CIMD advertised | 2/2 official checks; CIMD advertised | Preserved | 2/2 official checks |
| PKCE S256, HTTPS, RFC 9207 `iss` | S256, edge HTTPS/HSTS, `iss` advertised | S256, edge HTTPS/HSTS, `iss` advertised | Preserved | Pass |
| DCR extra grants | Rejected with 400 | Read-only metadata only | Unsupported grants narrowed to `authorization_code` and `refresh_token`; patch tracks workers-oauth-provider#422 | Pass |
| Redirect URI policy | Single custom/remote HTTP rejected; mixed list was accepted | Read-only metadata only | Every listed callback must be HTTPS or HTTP loopback; custom schemes and remote HTTP are rejected | Pass |
| Loopback port variance | Other port reached consent; other path rejected | Read-only metadata only | Provider behavior preserved | Pass |
| Access token lifetime and refresh | 3600 seconds in the deployed release | 3600 seconds in the deployed release | 900-second bearer tokens; refresh is issued without requesting `offline_access` | Pass |
| Revocation | Provider revoke returned 200 for unknown token | Provider revoke returned 200 for unknown token | MCP checks the authoritative connection row and returns 401 `invalid_token` immediately after owner revoke | Pass |
| DPoP | Not advertised | Not advertised | Plain audience-bound Bearer tokens; conformance DPoP scenario skips | Pass (skipped) |
| OIDC discovery fallback | `/openid-configuration` served SPA HTML | `/openid-configuration` served SPA HTML | Unsupported `/.well-known/*` paths return 404; `stellar.toml` remains available | Pass |

## Local proof

`bun run dev` was run with the local workerd stage at `http://localhost:18960`.

- Repository smoke: 9/9 checks passed.
- Official conformance: metadata 2/2, authorization-code-grant 1/1, DPoP skipped because Nod does not advertise DPoP.
- Browser flow: passkey consent, redirect-host warning, authorization code, `scope=wallet`, `token_type=bearer`, `expires_in=900`, refresh rotation, foreign-resource rejection, query-string/DPoP rejection, RFC 7009 revoke, immediate bearer invalidation, owner connection revoke and immediate 401.
- Full gate: `heavy --wait bun run check`, exit 0; 70 files passed, 2 skipped, 391 tests passed, 16 skipped.

The provider accepts the previous refresh token during its documented rotation grace behavior. Nod does not advertise DPoP and does not claim replay-family revocation beyond the provider's behavior.

## Cleanup

Eight testnet registrations created by the active probes were deleted through the OAuth Durable Object store. Readback found zero matching clients, grants, or access tokens. No mainnet rows were changed.
