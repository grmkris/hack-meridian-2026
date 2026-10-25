# S4 · Connecting real hosts to the spike server

For Kristjan. The spike agent cannot sign in to your Claude, Goblin or ChatGPT accounts, so these are the exact steps.
Results go in `docs/spikes/s4.md`. Claude comes first, because it is the recommended demo host (no transfer prohibition,
CIMD, and Claude Code has URL elicitation). Goblin is the fallback. ChatGPT is a cameo at most.

**Server:** `https://hm26-s4-mcp.kristjan-grm11775.workers.dev/mcp`

**Owner sign-in (spike only):** the dev password in `~/code/hack-meridian-2026/spikes/s4/.dev.vars`. Read it with
`cut -d= -f2 spikes/s4/.dev.vars`.

## What the server offers every host

| Thing                | Value                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Discovery            | `401` + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="wallet"`         |
| Authorization server | same origin; `/.well-known/oauth-authorization-server`                                                                    |
| Client registration  | **CIMD** (`client_id_metadata_document_supported: true`) **and DCR** (`/oauth/register`); public clients (`none`) allowed |
| PKCE                 | S256 only                                                                                                                 |
| Scopes               | `wallet` (required), `offline_access` (refresh tokens). Hosts request `wallet offline_access` by themselves               |
| Redirect URIs        | **nothing to allowlist.** DCR clients register their own, and CIMD clients publish theirs                                 |
| RFC 9207 `iss`       | returned on every authorization response                                                                                  |
| Tools                | `wallet_overview`, `payment_prepare` (→ `requires_approval` + `approval_url`), `payment_status`                           |
| Approval             | open the `approval_url`, enter the dev password, press **Approve**; the agent's next `payment_status` reads `confirmed`   |

## Host matrix

| Host                | Registration it uses                                                                                            | Redirect URI                                                                                                                     | URL-mode elicitation                                        | MCP Apps (`ui://`)               | Status in S4                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------- | ------------------------------------------- |
| Claude Code         | **CIMD** `https://claude.ai/oauth/claude-code-client-metadata` (seen)                                           | `http://localhost:<port>/callback` (seen)                                                                                        | **yes**: declares `elicitation: {form: {}, url: {}}` (seen) | no (ignores `ui://`)             | **connected live, PASS**                    |
| claude.ai / Desktop | **CIMD** `https://claude.ai/oauth/mcp-oauth-client-metadata` (fetched); DCR or a static client id also accepted | `https://claude.ai/api/mcp/auth_callback` (also allowlist `https://claude.com/api/mcp/auth_callback` for static clients)         | undocumented; rely on the link in the tool result           | yes (claude.ai and Desktop)      | server-side replay PASS; **run step 2**     |
| Goblin (dev)        | **DCR**, `client_name: goblin`, `token_endpoint_auth_method: none`                                              | `https://dev.goblin.surf/api/mcp/oauth/callback`                                                                                 | yes, on 2026 connections (ADR 0042, `input_required`)       | yes (`ui://` resources rendered) | same SDK path PASS headless; **run step 3** |
| ChatGPT dev mode    | CIMD preferred, DCR or static                                                                                   | `https://chatgpt.com/connector_platform_oauth_redirect` (we return `iss`) or `https://chatgpt.com/connector/oauth/{callback_id}` | UNVERIFIED                                                  | yes (web only)                   | not run; **step 4, optional**               |

Our server never needs elicitation or MCP Apps. Every tool result starts with a plain sentence containing the
`approval_url`, and the same data sits in `structuredContent`.

## 1. Claude Code (proven by the spike; about 2 minutes)

```sh
claude mcp add --transport http -s user stellarmcpwallet https://hm26-s4-mcp.kristjan-grm11775.workers.dev/mcp
claude mcp login stellarmcpwallet                 # opens the browser; on the netcup box (no browser) add --no-browser
```

- With `--no-browser` it prints an authorization URL. Open it on any machine and enter the dev password on the consent
  page, check the allowance (default 5.00 USDC until tomorrow 12:00 UTC), and press **Allow**.
- If the browser is not on the box, the redirect to `http://localhost:<port>/callback` fails to load. Copy that URL
  from the address bar and paste it at Claude Code's `Or paste the redirect URL here:` prompt.
- Interactive alternative: start `claude`, run `/mcp`, choose `stellarmcpwallet`, then **Authenticate**.
- No client id, secret or allowlisting is needed: Claude Code identifies itself with CIMD. The consent page shows
  "Published by **claude.ai**".
- Try it: _"Use stellarmcpwallet: show my wallet overview, then prepare 100 USDC to Bob for dinner."_ Open the
  `approval_url` it prints, approve, then ask it to check `payment_status`.
- To remove it: `claude mcp logout stellarmcpwallet && claude mcp remove -s user stellarmcpwallet`.

## 2. claude.ai custom connector (also appears in Claude Desktop)

1. Go to claude.ai → **Settings → Connectors → Add custom connector**. On Team or Enterprise, an Owner adds it under
   Organization settings. Free plans allow one custom connector.
2. Name: `stellarmcpwallet`. Remote MCP server URL: `https://hm26-s4-mcp.kristjan-grm11775.workers.dev/mcp`.
3. Leave **Advanced settings → OAuth Client ID / Secret empty**, so Claude uses its published CIMD identity. The spike
   replayed exactly that identity against the server: consent, 302 to `https://claude.ai/api/mcp/auth_callback`, token
   200, and tool calls 200.
4. Press **Add**, then **Connect**. Our consent page opens and should say "Connect **Claude** … Published by
   **claude.ai**. Access will be sent to **claude.ai**". Enter the dev password and press **Allow**.
5. In a new chat, enable the connector in the tools menu and send the same prompt as in step 1. Claude shows the
   `approval_url` as a link. Approve in another tab, then ask it to check the status.
6. **Record** for `s4.md`:
   - a screenshot of the tool calls
   - whether it asked for a client id (it should not)
   - whether any elicitation UI appeared (expected: none, just the link)
   - in the connector's tools list, whether the three tools show their read-only badges

## 3. Goblin (dev.goblin.surf)

1. Sign in at `https://dev.goblin.surf`, open **Connections**, and under **The server's address** paste
   `https://hm26-s4-mcp.kristjan-grm11775.workers.dev/mcp`. Press **Add**.
2. The new server card starts disconnected. Press **Connect** on it.
   - Goblin runs discovery and DCR. It registers as `goblin` with redirect
     `https://dev.goblin.surf/api/mcp/oauth/callback`, then sends you to our consent page.
   - The page says "This app registered itself; its name is not verified", which is the honest DCR wording. Access is
     sent to **dev.goblin.surf**.
3. Enter the dev password and press **Allow**. You land back in Goblin. Choose the three tools.
4. Ask the agent for the wallet overview and the 100 USDC payment, then approve via the link.
5. No allowlist or static client is needed, and Goblin only accepts public https servers (this one is).
   - The headless spike ran Goblin's exact SDK (`@modelcontextprotocol/client` 2.3.1) with a Goblin-CLI-shaped provider
     and passed 66 assertions. The only untested parts are Goblin's own web callback and its credential store.

## 4. ChatGPT developer mode (optional cameo)

- **Caveat first.** OpenAI's app policy lists "Execution of money transfers, crypto transfers" as prohibited for
  published apps. Whether that applies to a private developer-mode connector is UNVERIFIED. Plan gating for write
  actions is also unclear: the help center says Business/Enterprise/Edu, while the developer docs say Plus/Pro too.

1. Go to ChatGPT → **Settings → Apps & Connectors** (newer UI: **Plugins**) → **Advanced settings** → turn on
   **Developer mode**.
2. **Create** (or "Add custom connector"). Fill in name `stellarmcpwallet` and MCP server URL
   `https://hm26-s4-mcp.kristjan-grm11775.workers.dev/mcp`. Set Authentication to **OAuth**, leave client id and secret
   empty (ChatGPT uses CIMD or DCR by itself), and tick "I trust this application".
3. Sign in through our consent page (dev password, then **Allow**). ChatGPT's redirect is its own, so there is nothing to
   allowlist on our side.
4. In a chat, pick the connector in developer mode and run the same prompt. **Record** whether write tools
   (`payment_prepare`) were allowed and whether the link was clickable.

## If something fails

- Watch the server live with `cd spikes/s4 && npx wrangler tail hm26-s4-mcp --format pretty`. Each MCP `initialize`
  logs the host's `clientInfo`, `protocolVersion` and capabilities.
- Consent page says "Cannot authorize":
  - the host sent an unknown `resource`, or
  - a CIMD document could not be fetched. Note the `client_id` in the URL.
- 401 loops after Allow: the host is probably keying tokens by a different resource URL. The server's canonical
  resource is exactly `https://hm26-s4-mcp.kristjan-grm11775.workers.dev/mcp` (no trailing slash).
- Revoke a connection: open `https://hm26-s4-mcp.kristjan-grm11775.workers.dev/connections` and press **Revoke** with
  the dev password. The host's next call gets 401, and it should offer to reconnect.
