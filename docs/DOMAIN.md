# Nod hostnames and passkeys

The domain cutover completed on 25 October 2026. The [deployment log](../evidence/deployments/2026-10-25.md)
and [mainnet record](MAINNET.md) retain the release evidence. The old DNS activation checklist is complete.

## Host configuration

[`apps/web/alchemy.run.ts`](../apps/web/alchemy.run.ts) declares these canonical origins:

- Local: the incoming request's origin unless explicitly configured.
- Testnet: `https://testnet.trynod.si`.
- Mainnet: `https://trynod.si`, with `www.trynod.si` as an alias.

The stack's default `RP_ID` for remote stages is `trynod.si`. The recorded cutover explicitly overrides testnet to
`testnet.trynod.si`, keeping its passkeys separate from mainnet. Stage environment values override stack defaults;
inspect the intended public bindings in the deployment plan before changing either identity.

Custom domains attach when the effective `ORIGIN` matches the stage's canonical hostname. The stack rejects an
`RP_ID` that is neither the origin's hostname nor a parent of it. Cloudflare creates the domain's DNS and certificate
when it attaches the Worker to an active zone.

[`canonical.ts`](../apps/web/src/server/canonical.ts) redirects other origins to `ORIGIN`, preserving path and query:
GET/HEAD use 301; other methods use 308. GET/HEAD `/api/health` still answer on aliases. Local requests without a
configured `ORIGIN` are not redirected.

## Identity changes

Changing an RP id can strand existing passkeys. Moving an OAuth issuer/resource to another origin requires clients to
reconnect; a cross-origin redirect does not migrate their bearer tokens. The original workers.dev credentials did not
move to the custom domains.

After an authorized domain change, verify health, alias redirects, OAuth discovery, and passkey registration/sign-in.
Use [DEPLOY.md](DEPLOY.md) for the deployment procedure.
