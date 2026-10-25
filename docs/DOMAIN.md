# trynod.si: custom hostnames per stage

Plans and queues live in the release plan (.local/brainstorm/FINAL-REVIEW.md §K, tailnet); procedures below remain valid.

Track D of [MAINNET.md](MAINNET.md). Written 2026-10-25 ~17:30 UTC by the domain session. Nothing here has been
deployed; deploys run from the deploy worktree per [DEPLOY.md](DEPLOY.md).

## What the config does

`apps/web/alchemy.run.ts` has one map, `DOMAINS`, with the canonical hostname first:

| Stage   | Hostnames                    | ORIGIN default              | RP_ID default |
| ------- | ---------------------------- | --------------------------- | ------------- |
| local   | none                         | unset (the request's own)   | unset         |
| testnet | `testnet.trynod.si`          | `https://testnet.trynod.si` | `trynod.si`   |
| mainnet | `trynod.si`, `www.trynod.si` | `https://trynod.si`         | `trynod.si`   |

- An explicit `ORIGIN` / `RP_ID` in `apps/web/.env.<stage>` (or the shell) still wins over the defaults.
- **The custom domain follows ORIGIN.** Alchemy attaches the hostnames (Worker `domain` prop, by name only, the
  canonical one plus `www` as an alias on mainnet) only when the stage's effective ORIGIN is `https://<canonical>`.
  An ORIGIN pinned to the workers.dev URL leaves the domain out of the stack, so identity and attachment never disagree.
- The stack dies if RP_ID is not ORIGIN's host or a parent of it (a half-done cutover fails at plan time, not at the
  first passkey).
- `workersDev: true` stays: the workers.dev hostname keeps resolving.
- **One identity per stage** (`apps/web/src/server/canonical.ts`, called first in `src/worker.ts`): when ORIGIN is
  set and the request's origin differs from it (workers.dev, `www`, a version preview, plain http), the Worker answers
  301 (GET, HEAD) or 308 (every other method, so a POST to `/mcp` keeps its body) to ORIGIN with path and query.
  Only `GET`/`HEAD /api/health` is answered on every host, so a probe can still read the release through the alias.
  No ORIGIN (local) or the request is on ORIGIN: no redirect.
- Already following ORIGIN (A1, verified, unchanged): passkey origin and RP id (`siteOf`), the protected-resource
  metadata (`resource`, `authorization_servers`), approve/claim/revoke/request links, `/sample`'s site. The
  authorization-server `issuer` is the request's origin (no `issuer` option is set); the redirect makes that ORIGIN too.

## What stops the cutover today

Both copies of `apps/web/.env.testnet` (main checkout and `/srv/cache/hm26/deploy-testnet`) pin `ORIGIN` and `RP_ID`
to the workers.dev host (checked by matching the lines, values not printed). While those two lines are there, a testnet
plan shows no domain and no ORIGIN/RP_ID change, and the redirect is a no-op on workers.dev. That makes every testnet
deploy before the cutover safe, including the MCP-Apps session's.

The cutover is deleting those two lines, without reading the file, in **both** copies (or a re-copy from main undoes
it). Keep an unread backup first; it is the rollback:

```sh
install -m 600 apps/web/.env.testnet apps/web/.env.testnet.pre-domain                               # both copies
sed -i -E '/^(export )?(ORIGIN|RP_ID)=/d' apps/web/.env.testnet                                    # main checkout
sed -i -E '/^(export )?(ORIGIN|RP_ID)=/d' /srv/cache/hm26/deploy-testnet/apps/web/.env.testnet    # deploy worktree
```

Then `bun run plan:testnet` in the worktree must show `[Web] update` with `[Web/ORIGIN] update`
(`https://testnet.trynod.si`), `[Web/RP_ID] update` (`trynod.si`) and `[Web/RELEASE] update`, and nothing else beyond
what the SHA itself brings. In Alchemy 2.0.0-beta.83 a custom domain is a prop of the Worker, not a resource of its own,
so the hostname has no plan line: `bun run plan:testnet --detailed --include Web` prints the props (secrets show as
`(redacted)`) and must contain `domain: name: testnet.trynod.si`. Changing `domain` never replaces a Worker (only name,
account or namespace do). Stop on any delete or replace, as always.

Checked from the main checkout (its state copy is stale, so only the props are meaningful): with the two lines in place
the testnet props have no `domain`; a mainnet plan (no `.env.mainnet`, placeholder secrets, nothing written) has
`domain: { name: trynod.si, aliases: [www.trynod.si] }`, `ORIGIN: https://trynod.si`, `RP_ID: trynod.si`,
`workersDev: true`.

Mainnet: `.env.mainnet` (M1) should say `ORIGIN=https://trynod.si` and `RP_ID=trynod.si`, or leave both out.

## Zone status and the token

- Zone `trynod.si` (`bb3a9d81…`, Free) is **pending** at 17:25 UTC. The .si registry's RDAP already lists
  `kenneth.ns.cloudflare.com` / `sima.ns.cloudflare.com` (registered today), but the published .si zone still answers
  NXDOMAIN for `trynod.si` (SOA serial = 16:00:28 UTC; the zone looks to be republished hourly). Cloudflare activates
  after the delegation is published and its next check sees it. Check:
  `dig +norec NS trynod.si @b.dns.si` (needs the two Cloudflare names), then the zone status in the dashboard.
- The API token can write here: the zone object the token reads lists its rights on the zone as `#dns_records:edit`,
  `#worker:edit`, `#zone:edit`, `#ssl:edit`, and the token already deploys Workers (attach needs Workers Scripts Write).
  The same account has 29 Worker custom domains (myapps, goblin, mjavmjav). Nothing was created to find this out.
- **A pending zone blocks it.** Cloudflare's Custom Domains page lists "an active Cloudflare zone" as the first
  requirement. Alchemy finds the zone by name (the lookup ignores status) and PUTs `/workers/domains` during the deploy,
  after the script upload; nothing attaches later by itself. So "deploy anyway, the hostname attaches when the zone
  activates" does not hold: expect the attach (and the deploy) to fail, or at best a hostname with no certificate until
  activation. Untested, because testing means creating a record. Rule: **cut over only after the zone is active.**

## DNS records

Alchemy creates no DNS records itself. Attaching a custom domain makes Cloudflare create, per hostname, a proxied,
read-only `AAAA 100::` record (`meta.origin_worker_id`, as on `mjavmjav.com` / `www.mjavmjav.com` in this account) and
the edge certificate. Testnet: `testnet.trynod.si`. Mainnet: `trynod.si`, `www.trynod.si`. The zone has no records
now, so there are no CNAME conflicts.

## Cutover consequences

- Passkeys bind to the RP id. Every testnet wallet made on workers.dev (RP id = the workers.dev host) stops being
  usable: workers.dev now redirects to `testnet.trynod.si`, where those credentials cannot be asked for. Their testnet
  funds stay onchain and unreachable. Disposable, but announce it.
- Claude connectors and OAuth tokens issued on workers.dev stop working: the issuer and resource move, and clients drop
  the `Authorization` header on a cross-origin redirect. Re-add the connector with `https://testnet.trynod.si/mcp`.
- Approve/claim links already handed out on workers.dev redirect to the new host and need a new-host passkey.
- With RP_ID = `trynod.si` on both stages, one authenticator holds both stages' passkeys and the browser offers both on
  either host, but each stage only knows its own wallets: a testnet passkey does not open a mainnet wallet. Give
  wallets telling names. If that list is too confusing, decide **before** the cutover: `RP_ID=testnet.trynod.si` in
  `.env.testnet` keeps the stages apart (changing it later orphans wallets again).
- The same holds for mainnet, with real money: its RP id must be settled before the first mainnet wallet exists.
  Mainnet ships on `trynod.si` only once the zone is active. If it ships earlier on workers.dev, moving it later orphans
  Kristjan's mainnet wallet.
- The workers.dev URL is still hard-coded in `scripts/{smoke,shots,site-e2e,landing-shots,stage}.ts` and
  `scripts/demo/targets.ts`; GETs follow the redirect, but the testnet targets should move to the new host.

## Sequence

1. The zone is active (`dig` above shows the Cloudflare nameservers; the dashboard says Active).
2. Delete the two lines in both `.env.testnet` copies; plan in the worktree (update of `Web` only, as above).
3. Cutover deploy from the worktree (DEPLOY.md), announced, with no rehearsal or recording in flight.
4. Verify (below). Rollback: restore `.env.testnet.pre-domain` over `.env.testnet` in both copies and redeploy the same
   SHA. The domain leaves the stack but stays attached (Alchemy leaves an omitted `domain` alone) and redirects to
   workers.dev; testnet.trynod.si wallets are then orphaned in turn. Re-pinning `4dd5d42` with the restored file also
   works.
5. Kristjan re-adds the Claude connector with `https://testnet.trynod.si/mcp` and creates a new wallet there.
6. a3 sweeps the published URLs in the same window.
7. Only then: recording.

**If the zone is still pending at 20:00 UTC:** no cutover. The testnet stage keeps workers.dev as its only identity
(leave the two lines), and only the mainnet stage ships on the domain, once the zone is active.

## Verification after the cutover deploy

```sh
N=https://testnet.trynod.si; W=https://hack-meridian-testnet.kristjan-grm11775.workers.dev
dig +short testnet.trynod.si                                         # Cloudflare addresses
curl -s $N/api/health | jq '{release, network}'                      # release = the deployed SHA
curl -s $W/api/health | jq .release                                  # still answers through the alias
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $W/mcp       # 301 https://testnet.trynod.si/mcp
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST $W/mcp  # 308 https://testnet.trynod.si/mcp
curl -s $N/.well-known/oauth-authorization-server | jq .issuer        # "https://testnet.trynod.si"
curl -s $N/.well-known/oauth-protected-resource/mcp | jq '{resource, authorization_servers}'
                                                                     # https://testnet.trynod.si/mcp, [https://testnet.trynod.si]
curl -s -X POST -D - -o /dev/null $N/mcp | grep -i www-authenticate  # resource_metadata on testnet.trynod.si
```

Then in a browser on `https://testnet.trynod.si`: create a wallet (the passkey prompt names `trynod.si`), sign out,
sign back in, open an approve link. Last, Kristjan removes the old Claude connector, adds
`https://testnet.trynod.si/mcp`, authorizes with the new passkey and runs one tool call.
