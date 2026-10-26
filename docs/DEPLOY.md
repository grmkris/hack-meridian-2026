# Deploying Nod

The authorized deployer uses `/srv/cache/hm26/deploy-testnet` for both remote stages. It holds the authoritative
Alchemy state under `apps/web/.alchemy/state/hack-meridian/{testnet,mainnet}` and the stage environment files.
The main checkout's state is stale. Never deploy from it or delete the deployment worktree.

Deploys remain serialized under the delivery session's ownership. Mainnet requires the owner's explicit go after
the same commit passes on testnet. Hold deploys during a rehearsal or recording.

## Prepare

Use a clean deployment checkout pinned to the intended commit. Install with `bun install --frozen-lockfile`, then
run `heavy bun run check` there; exit 75 means wait and retry. If a stage's environment file changes, copy it unread
with `install -m 600` from the main checkout. Never print secrets. Confirm the intended `ORIGIN` and `RP_ID` in the
plan; [DOMAIN.md](DOMAIN.md) describes the identity settings.

Run Alchemy only through [`scripts/stage.ts`](../scripts/stage.ts). It sets the release from Git and keeps cloud
credentials out of the local stage. Dirty product paths add `-dirty` to the release; deploy committed source.

## Plan and deploy

From the deployment checkout:

```sh
bun run plan:testnet
bun run deploy:testnet
bun run smoke:testnet
```

Inspect the plan before applying it. Stop on unexpected deletion, replacement, transfer, or unbinding. Migrations
must be additive. A new secret must be in the stack's `SECRETS` list and the stage environment file.
Check the deploy log for Durable Object class changes, including `deletedClasses`.

For an authorized mainnet promotion, use `bun scripts/stage.ts plan:mainnet` and
`bun scripts/stage.ts deploy:mainnet` from the same checkout. Both stages' state and secrets stay there.

## Verify the release

- Read `https://testnet.trynod.si/api/health` or `https://trynod.si/api/health`; `release` must equal the pinned commit
  and the network must match the stage. Check payments, signup settings, relayer health, and contract TTLs.
- Run testnet HTTP smoke and save the result. Mainnet smoke needs its counter result interpreted separately:
  the toolchain counter is testnet-only, so `404 NotDeployed` is expected there. Report that limitation explicitly.
- Check the served assets or text affected by the release against the deployment build. For UI changes, use
  screenshots and the relevant browser acceptance checks.
- Run `bun scripts/site-e2e.ts testnet` when wallet lifecycle coverage is needed. Each run creates a wallet funded
  with 10 testnet USDC. Rehearsal and probe commands are documented in [`scripts/demo/README.md`](../scripts/demo/README.md).
- Record the commit, plan scope, deploy result, smoke result, and any transaction links under `evidence/`.
  Local checks, deployed behavior, and onchain settlement are separate proof levels.

## Release history

The [25–26 October deployment log](../evidence/deployments/2026-10-25.md) retains dated release receipts.
Later landing releases have receipts under [`landing-entry/`](../evidence/landing-entry/),
[`landing-trim/`](../evidence/landing-trim/), and [`mobile-media/`](../evidence/mobile-media/).
These are historical snapshots. Read health for the current release instead of treating an old SHA as live.
