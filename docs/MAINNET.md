# Mainnet and trynod.si: the plan

Status: started 2026-10-25 16:10 UTC on Kristjan's go ("start thinking about mainnet deployment and the trynod.si
migration; you can do both independently"). Facts come from `docs/research/mainnet.md`; the deploy mechanics from
`docs/DEPLOY.md`. Nothing on mainnet moves money until Kristjan funds the accounts and says go for each step that
spends.

## Goal

Nod on mainnet end to end at **https://trynod.si**, invite-only, with Kristjan's own wallet and a real small flow
proven with mainnet hashes; judges keep the auto-funded testnet stage.

## Two independent tracks

### Track M: mainnet stage

| Step                                                                                                                                                                                                                                                                         | Who             | Spends real money                                    | Notes                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Create the mainnet keypairs: relayers ×2, treasury, seller payTo, demo contacts Alice (smart account), Bob (G + USDC trustline), Carol (G, no trustline); write `apps/web/.env.mainnet` and `scripts/demo/.env.pubnet`, mode 600, never printed                           | agent "mainnet" | no                                                   | STELLAR_NETWORK=pubnet, INVITE_CODES set, WELCOME off, caps 20/50/1, fee ceilings 1 XLM, PAYMENTS_ENABLED=true, RP_ID/ORIGIN = trynod.si |
| M2 Print the funding table: addresses and amounts (relayers 25 + 10 XLM, treasury 3 XLM + 30 USDC, seller 2 XLM, Bob 2 XLM + trustline, Carol 2 XLM, Alice's deploy from a relayer)                                                                                          | agent           | no                                                   | Kristjan funds; USDC goes to the **treasury G account** with an ordinary payment from any wallet                                         |
| M3 After funding: deploy the onboarding router (`contracts/onboard`, same WASM 39c97734…) on mainnet; record `ONBOARD_ROUTER_ID` in `.env.mainnet` and `contracts/deployments/mainnet.json`                                                                                  | agent, on my go | ~2.5 XLM                                             | reproducible hash check against the upload                                                                                               |
| M4 Mint an OpenZeppelin Channels mainnet key (`/gen`) into the seller and service secrets; deploy `hm26-seller-mainnet` (OZ Channels, USDC `CCW67TSZ…`); pay it once from a G account                                                                                        | agent, on my go | 0.10 USDC + fees                                     | the third-party facilitator proof on pubnet                                                                                              |
| M5 Seed Bob (trustline), Carol (no trustline), deploy Alice's smart account; `DEMO_CONTACTS` for mainnet = these three (ours)                                                                                                                                                | agent, on my go | reserves + fees                                      |                                                                                                                                          |
| M6 Deploy the `mainnet` stage from the deploy worktree at the SHA that passed the testnet test, with `.env.mainnet`; verify release, smoke, `/api/health` (network pubnet, invite_required true, payments_enabled, ceilings, relayers)                                       | me              | deploy only                                          | separate Alchemy state for the mainnet stage; `/sample` is disabled on pubnet by design                                                  |
| M7 Kristjan creates his mainnet wallet with an invite code through the Claude connector; treasury tops it up to 30 USDC; one small real flow: 0.10 x402, 2 USDC to Alice, 5 USDC dinner with the nod, 1 USDC to Carol via the claim link, revoke; hashes into README/landing | Kristjan + me   | ~9 USDC moved between our own accounts, cents of XLM | the mainnet proof set                                                                                                                    |
| M8 Go/no-go for recording on mainnet by ~07:00 UTC; otherwise the video stays on testnet and mainnet is the live product                                                                                                                                                     | Kristjan        |                                                      |                                                                                                                                          |

Caps and switches on pubnet: MAX_GRANT_USDC 20, MAX_OWNER_PAYMENT_USDC 50, MAX_X402_PRICE_USDC 1, fee cap 1 XLM per
transaction, `PAYMENTS_ENABLED` kill switch, invite-only signup, no auto-fund, never a `Delegated` signer. RPC
`https://mainnet.sorobanrpc.com` with the gateway.fm fallback.

### Track D: trynod.si

Zone `trynod.si` is in the Cloudflare account (id `bb3a9d81…`, Free plan), status **pending** at 16:10 UTC: Cloudflare
has not yet seen the nameservers `kenneth.ns.cloudflare.com` / `sima.ns.cloudflare.com` at the registry, and the zone has
no DNS records. Until it is active, custom hostnames do not resolve. An activation check was triggered.

Mapping (default, Kristjan to confirm):

| Host                                  | Stage   | Notes                                                                   |
| ------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `trynod.si`, `www.trynod.si`          | mainnet | the product; landing with "try it on testnet" link; invite-only signup  |
| `testnet.trynod.si`                   | testnet | judges, auto-fund, `/sample`; workers.dev URL keeps working as an alias |
| (unchanged) `hm26-seller…workers.dev` | seller  | no domain needed                                                        |

Passkeys bind to the relying-party id. Both stages set `RP_ID=trynod.si` so one passkey can serve both hosts, with
`ORIGIN` per stage. Changing the testnet stage's RP id orphans the test wallets created today on workers.dev; that is
acceptable (they are disposable) but it is a cutover: do it once, announce it, and have a3 sweep every published URL
(README, llms.txt, judge path, deck, landing) in the same window. If the zone is not active by ~20:00 UTC, mainnet still
ships on its workers.dev hostname and the domain follows when DNS lands.

Steps: D1 Alchemy custom domains for the Worker in `apps/web/alchemy.run.ts` (per stage, from a `DOMAINS` map; DNS
records created by Alchemy or the API; proxied) and `RP_ID`/`ORIGIN` from the same map; D2 plan on the testnet stage
shows the new hostname as a create only; D3 deploy testnet with `testnet.trynod.si` (cutover), verify passkey creation on
the new host, update published URLs; D4 the mainnet stage ships with `trynod.si` from its first deploy.

## Test gate before any mainnet deploy

The SHA must have passed on testnet: `heavy bun run check`, the automated rehearsal s1–s11 on the public URL, one
`/sample` run, and Kristjan's manual claude.ai flow. The first mainnet deploy happens after the MCP-Apps session's
~23:00 UTC testnet deploy passes that gate, or at the frozen `4dd5d42` if that deploy slips.

## What Kristjan does

1. Confirm the mapping above (or say "mainnet only on the domain").
2. Make sure the registrar points `trynod.si` at `kenneth.ns.cloudflare.com` and `sima.ns.cloudflare.com` (if the
   transfer to Cloudflare Registrar completed, this is automatic; the zone flips to active when the registry shows it).
3. Fund the addresses from the M2 table when it arrives (~50 XLM, ~30 USDC).
4. Have an invite code ready (the agent generates one into `.env.mainnet`; I send it to you privately).
5. Create your mainnet wallet through the Claude connector on trynod.si and run the small flow with me.

## Decisions 17:30 UTC

- Domain config landed (`1bf2930`, `docs/DOMAIN.md`): custom hostnames per stage, the alias host 301/308-redirects to the
  canonical origin once `ORIGIN` is set, token verified able to attach domains. The .si registry already lists Cloudflare's
  nameservers; the zone activates when the registry publishes (a watch re-triggers the activation check every 15 min until
  20:00 UTC). Cloudflare attaches a custom domain only to an active zone, so no cutover before activation.
- **Relying-party ids are per stage**: testnet `testnet.trynod.si`, mainnet `trynod.si`, so the browser never offers testnet
  passkeys on mainnet. The cutover edits the two non-secret lines in both copies of `apps/web/.env.testnet` to
  `ORIGIN=https://testnet.trynod.si` and `RP_ID=testnet.trynod.si` (not deleting them), then deploys.
- After the cutover, wallets and Claude connectors made on workers.dev stop working (redirects drop bearer tokens):
  Kristjan re-adds the connector at `https://testnet.trynod.si/mcp` before recording.

## Decisions 17:10 UTC (Kristjan, via the orchestrator)

- **Full roster funded** (44 XLM + 30 USDC, `docs/mainnet-funding.md`) so every flow is tested on mainnet; the demo itself
  is "just USDC and a clean UX". Onboarding and use on mainnet must work without friction: today that is Kristjan paying
  USDC to the treasury `G…` and `scripts/demo/topup.ts` moving it into his `C…` wallet (classic wallets cannot pay a
  contract address). The non-custodial pattern to adopt later is Nido's nidohq/nido#165: a sponsored burner `G…` per
  wallet with a preauthorized sweep policy on the `C…`, permissionless sweep, teardown by merge (their policy is on
  testnet, wiring in their PR #199).
- **Autonomous line user-definable per allowance**, default 1 USDC; the demo uses 1 (work item W1 in the orchestrator's
  plan; copy changes only after it is deployed).
- **Account WASM on mainnet: open**, Kristjan wants the brainstorm. Facts: the same `1b5f4534…` build exists on mainnet and
  is what Smart Account Kit targets; current OpenZeppelin `stellar-accounts` 0.8.0 (2026-10-20) has a new signing digest,
  needs soroban-sdk ^28 (workspace is 29), ships no WASM, so verifiers and policy would be ours to build and deploy and
  the signer rewritten: 4–6 h plus a new authority test; the advisory fixed in 0.7.3 concerns Delegated signers only,
  never used here. Default: same WASM, disclosed, upgrade after the deadline.
- **OpenZeppelin Channels as fee payer: later** (pays fees only; reserves, account creation and Alice's deploy still need
  our ops account; its fee cap is below testnet's rent-driven costs today, fine on mainnet).
- **`/sample` on mainnet: off by default**; enable only with cents-level amounts after the first real flow, if at all.
- **Zone `trynod.si` active at 17:12 UTC.** The mainnet stage ships on `trynod.si` from its first deploy; the testnet
  cutover to `testnet.trynod.si` happens tonight after the MCP-Apps combined deploy verifies.
