# S8 · Deposit addresses: a `G…` anyone can pay that lands in the passkey wallet

Status: **PASS** on Stellar testnet (protocol 29), 2026-10-25 18:10–18:45 UTC. Evidence: unit (Rust and TypeScript),
fixture service tests, and one live testnet run with hashes below. **Nothing on mainnet**: the pubnet preset has no
deposit router, so the feature answers `404 deposit_unavailable` there until it is deployed on Kristjan's go.

## Question

Exchanges withdraw to classic `G…` accounts, and a Nod wallet is a contract (`C…`). Can every wallet get a deposit
address that anyone can pay any amount of USDC to, any number of times, with no memo, where nobody, Nod included, can
move the money anywhere except into that wallet?

**Answer: yes.** The design comes from Nido, [nidohq/nido#165](https://github.com/nidohq/nido/issues/165) (policy in
[PR #166](https://github.com/nidohq/nido/pull/166), wiring in [PR #199](https://github.com/nidohq/nido/pull/199)): a
sponsored, zero-balance `G` grants an allowance and then loses its signing power, and a bounded, permissionless
`transfer_from` sweeps whatever arrives.

## Decision: the bound lives in the spender contract, not in a policy on the account

Nido makes the smart account the spender and puts a signer-less context rule with a sweep policy on it. We can't
install that rule without the owner. On our account (WASM `1b5f4534…`, OpenZeppelin `stellar-accounts` at
`1e513890`), `add_context_rule` calls `e.current_contract_address().require_auth()`, and only rule 0, the passkey,
satisfies that. Nido has the passkey sign the install too (#165, Phase 1). We create the address on a plain
`GET /api/wallet/deposit-address`, so no passkey is present.

So the spender is **our own deposit router**, [`contracts/deposit`](../../contracts/deposit/src/lib.rs). It has the
same allowance and the same bounded, permissionless sweep. The account's rules stay untouched and no passkey tap is
needed. The guarantee is unchanged: once registered, funds on G can only reach the recorded C.

Why we didn't reuse Nido's deployed policy (`CAEGA6AK…`):

- It is built against a fork (theahaco `stellar-accounts` 0.7.1 at `3372676`, soroban-sdk 27, Perch account), not
  our account build.
- It still needs the passkey to install.
- It exists only on testnet, and mainnet would need our own deploy anyway.

The router is plain soroban-sdk 29 and builds in this workspace.

| Router                      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testnet id (v2, in use)     | [`CAFLFU5GH7QZ6KF3FBKRV7VW5XFYUKQPCFFTCPTKVEUG4TDT5B2ZOXGL`](https://stellar.expert/explorer/testnet/contract/CAFLFU5GH7QZ6KF3FBKRV7VW5XFYUKQPCFFTCPTKVEUG4TDT5B2ZOXGL), wasm `7bc3752b337ff7b4c13683e5d1861d404ff069b01cf3c1ff4748055c48fb0c14`                                                                                                                                                                                                                                                                                                  |
| Upload / deploy             | [97c2ba75…](https://stellar.expert/explorer/testnet/tx/97c2ba7599a56e1cbd49af50a55c55a76a7c9a06bbb85e7958aa868448f500bf) / [5754d3a8…](https://stellar.expert/explorer/testnet/tx/5754d3a8324c2932104bdde38583255c6ecbdf3f7945d407dc5c038c82c04df7); TTL extended ~3 M ledgers (instance [746f6a44…](https://stellar.expert/explorer/testnet/tx/746f6a44fea4acbeefdee28a5634149219b1d97bc5e73a6bad7f6012e788cf87), code [43e1ba39…](https://stellar.expert/explorer/testnet/tx/43e1ba3980cd756a78f2ff849dba703970d628a17bfc082f505a3243024a93f2)) |
| v1 (unused)                 | `CBYNVNG4XA5EMPEVBMTMI2I6GRSCGTFE3HQDUYANTVJ5VD3E6WTNEXEL` (wasm `acef0d89…`): `register` computed the approve expiry from the ledger at apply time, so G's authorization, signed at simulation time, never matched onchain ([faf6852c…](https://stellar.expert/explorer/testnet/tx/faf6852c2858c518a266dfe0531984a7728bfb86d3d32baf3ef76e8500760e7d), `Error(Auth, InvalidAction)`)                                                                                                                                                              |
| Token (constructor, pinned) | testnet USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Interface: `register(g, recipient, expiration_ledger) -> u32`, `sweep(g) -> i128`, `deposit(g) -> Option<Deposit>`,
`max_expiration_ledger() -> u32`, `token() -> Address`. Events `registered(g, recipient) {expiration_ledger}` and
`swept(g, recipient) {amount}`. Errors `AlreadyRegistered` 1, `NotRegistered` 2, `SameAddress` 3,
`NothingToSweep` 4, `ExpirationInPast` 5.

- `register` requires G's authorization. It binds G to C once: a second registration of the same G is refused
  forever, even when G signs it. Under that same authorization it calls `USDC.approve(g, router, i128::MAX,
  expiration_ledger)`, which is one auth tree for G.
- The caller passes the expiry: `max_expiration_ledger()` (current ledger + the network's max entry TTL, ~180 days)
  minus 100 ledgers, so it still fits when the transaction applies.
- `sweep` needs nobody's authorization. The router is the spender and the SAC's direct caller. It moves
  `min(balance(g), allowance(g, router))` to the recorded C and nowhere else.
- There is no admin, no upgrade and no setter. The binding is persistent, with its TTL set to the allowance's.
- Unit tests (15, `bun run contracts:test`):
  - the exact auth tree G signs, and that it does not depend on the ledger it lands in
  - a second registration refused, even by G
  - a sweep with no authorization at all, paying only C
  - a G that kept its key (master weight never set to 0) still sweepable only to C
  - `min(balance, allowance)`
  - nothing approved, an empty G, a G without a trustline, an unregistered G
  - an expiry in the past or past the maximum
  - events

## The flow (`Chain.createDepositAddress`, packages/stellar/src/deposit.ts)

G's fresh key exists only inside the call. The relayer is the source and pays for all of it.

1. **create**: `beginSponsoring(G)`, `createAccount(G, 0)`, `changeTrust(USDC)` (G), `endSponsoring` (G).
2. **register**: `router.register(G, C, max − 100)`. G signs the Soroban auth entry; the relayer submits it after the
   enforce simulation.
3. **lock** (sponsored): `setOptions` on G with master weight 0 and **one pre-authorized-transaction signer**, the
   hash of G's teardown. From then on G can authorize nothing but that one transaction. The key is dropped.

The **teardown** (`StellarOps.closeDeposit`) is that transaction, fee-bumped by a relayer: drop the trustline, then
merge into the relayer, and the sponsored reserves come back. A teardown signed by G's key before the lock does not
work, and the first live run showed it (`txFeeBumpInnerFailed`): signatures are checked against G's signers at
submission, when the master key weighs 0. The teardown is a bearer transaction that can only close G. If G still holds
USDC it fails and uses up G's one sequence number, and G then stays open and sweepable.

`Chain.sweepDeposit(g, contractId)` reads G's balance first, so an idle address costs one ledger read and no
simulation. Next it checks that the router binds G to `contractId` (`deposit_mismatch` otherwise), then submits
`router.sweep(G)` with no auth entries. It returns null when there is nothing to take.

## Live run (testnet, 18:29–18:31 UTC, `STELLAR_LIVE=1 bunx vitest run --root packages/stellar test/deposit-live.test.ts`)

The treasury `G…` stands in for an exchange: a plain classic USDC payment, no memo, no Soroban.

| Step                                                                                       | Transaction                                                                                                              | Fee (XLM)                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Passkey wallet C `CBUPQ3UMSNY4G3DUWJYXZ2SROZ5EN4Z7WCGZGXI7GXQ7ALVKGE44OBG4` deployed       | [243501b9…](https://stellar.expert/explorer/testnet/tx/243501b90b089b7a9d15f42e823ff1aa9a840312bea8ce49c8ac8a026b1c919e) |                                       |
| create: sponsored G `GB7EGCF2J4WRZM74ZSMCLYIB2A3M5Z4NO2EGRSYTCXIIXBO4IYMSZ4VQ` + trustline | [ad82b359…](https://stellar.expert/explorer/testnet/tx/ad82b35901c6c5dee76ac430edc32d19b6b7e1de3be01c2cca1c2c9ff2ea4473) | 0.00004                               |
| register (approve until ledger 8,496,182)                                                  | [3c2d253d…](https://stellar.expert/explorer/testnet/tx/3c2d253df23b2167716655fb87a3776bed00e4038b10b95684e2af3e49eeccaa) | 0.0974 (0.0964 rent, ~180 days)       |
| lock: master weight 0, the pre-auth teardown hash as the only signer                       | [0998d2f9…](https://stellar.expert/explorer/testnet/tx/0998d2f98263af425dd0338c0f1987a0154e95a8942843fb9d8e81fa48f4f36f) | 0.00003                               |
| G read back: 0 XLM, thresholds 0/0/0/0, 1 signer (`preAuthTx`), 2 subentries               |                                                                                                                          |                                       |
| Exchange (treasury) pays 2 USDC to G                                                       | [0f299152…](https://stellar.expert/explorer/testnet/tx/0f299152e9e83fd56963a8afc29e547a95ea10d50b30f8b709e475455ff4a27a) |                                       |
| Sweep, by the relayer with no authorization: 2 USDC to C                                   | [efcbcc48…](https://stellar.expert/explorer/testnet/tx/efcbcc48ba6860d72243ff97eaa7d3e082218b312438d8b5969282936e9d2017) | 0.0105 (C's first USDC balance entry) |
| Exchange pays 0.75 USDC again                                                              | [0d5d09d5…](https://stellar.expert/explorer/testnet/tx/0d5d09d5d668ca2685d17145d94f399d6c0871055879fee5f8724f1ebeec3f67) |                                       |
| Sweep naming another wallet: refused before submitting (`deposit_mismatch`)                |                                                                                                                          |                                       |
| Sweep: 0.75 USDC to C; C holds **2.75 USDC**                                               | [6509c222…](https://stellar.expert/explorer/testnet/tx/6509c22269a78b60c0776d43855db7d612f7b49030ce5bb8b4b55785caa67e68) | 0.0009                                |
| Sweep of the empty G: null, nothing submitted                                              |                                                                                                                          |                                       |
| Teardown: the pre-authorized merge, fee-bumped; G no longer exists                         | [71d2bb8e…](https://stellar.expert/explorer/testnet/tx/71d2bb8e4879af5bbafc606c6912eb349b3b5ca45ad1f67de3533c7a918659a8) | 0.00003                               |

A second run on the final code (balance read before the router view, `registeredLedger`), 18:42 UTC, passed all five
steps the same way: G `GDMBP7WBSEVTEELZX56KKSZWU7GYGOROE3HISKJ2EVCTYV3WLKPHUBCX` for C
`CC7QN7CE7JSHEGFWPLLJTA5KI2CCTI4BWYOUTXBZHU34AC5LWAADOJQI`. Its transactions were create
[b177f3c2…](https://stellar.expert/explorer/testnet/tx/b177f3c2d4f6b9fd58450a6cb3ee1f97c621bb8da6d92f8429c129d61c79e4e4), register
[65e54382…](https://stellar.expert/explorer/testnet/tx/65e5438267f485e9a6f21ac85c0d2957fb3be18856189c473f42bd5feb944682), lock
[a593816f…](https://stellar.expert/explorer/testnet/tx/a593816f1f511865703a7af8e586c099b21d3ccb5a0b7748d157386efbfe0087), sweeps
[edc8f3b2…](https://stellar.expert/explorer/testnet/tx/edc8f3b24ad5fa1216d9d2eee5438ed492229ea2023bd76db343c976a537672c) and
[39084fbd…](https://stellar.expert/explorer/testnet/tx/39084fbd4d18b590c160514a15bf0825e03e0c8d92683d5b43851960441ebe26), and teardown
[903ec584…](https://stellar.expert/explorer/testnet/tx/903ec584b1b72895bd1921802e38baa46f9db92210a2b2328f08766b8a60da75). C ended with 2.75 USDC.

**Cost per deposit address** (testnet, rent at its floor today):

- About **0.097 XLM**, not reclaimable: almost all of it is rent for the binding and the allowance for ~180 days.
- **2 XLM** of sponsored reserve (account 1, trustline 0.5, pre-auth signer 0.5), which comes back to the relayer at
  teardown.
- Each sweep costs 0.001 XLM, or about 0.01 XLM the first time a wallet holds USDC.

Earlier runs left two testnet Gs stranded at 1.5 XLM of reserve each. `GCH4GRJX…` was never registered (the v1
router). `GDKXTQEX…` was locked without a teardown signer; its 2.75 USDC was swept.

## The service (apps/web/src/server/deposit.ts, migration 0007)

- `GET /api/wallet/deposit-address` (owner session) answers `DepositAddressView`:
  `{address, recipient, expires_ledger, expires_at, pending, swept_total, create_tx, register_tx, lock_tx, last_sweep_tx}`.
  - The first call claims the wallet's row and builds G (~15 s). A concurrent call gets `503
    deposit_address_creating`. A failed build is retried by the next call with a new G. A claim older than 2 min is
    taken over.
  - Where the network has no router, it answers `404 deposit_unavailable`.
- `POST /api/wallet/sweep` answers `{swept, tx, deposit}`, with `swept "0"` and `tx null` when G was empty.
- `/api/overview` and `WalletSummary` carry `deposit_address` once it exists.
- **Automatic sweep**:
  - Every GET marks the address watched for 24 h and pokes the wallet's Durable Object.
  - The object's alarm, shared with MCP Events (`armAt` only moves it earlier), sweeps every 60 s while the watch
    lasts. A sweep emits the SAC's own `transfer [G, C, USDC]` event (checked in the run's sweep), which matches the events watcher's `[transfer, *, C, *]` filter for `payment.received`.
  - After the watch ends, a deposit waits, safe on G, for the next GET or POST.
- Table `deposit_addresses`, keyed by wallet: status, claim, address, expiry, proof hashes, the teardown XDR (it can
  only close G), swept total, last sweep, watch end.

## Deposit-first signup (405498e, migration 0008)

On a network with a deposit router and no welcome USDC (pubnet, once its router exists), or when `POST /api/wallets`
says `deposit_first`, signup deploys nothing. `Chain.planAccount` fixes the wallet's `C…` in advance: the primary
relayer is the deployer and the salt is random, the way scripts/mainnet/seed.ts precomputes Alice's id. The deposit
address is bound to that planned `C…`. SAC transfers and the router's sweep both reach an undeployed contract address
(checked by simulation, then live). The account deploys at its planned id (`Chain.deployPlannedAccount`) when USDC is
on the wallet, or before an AI app's first allowance, because the rule install needs the account.

Live on testnet through the local stage (`evidence/deposit-first/`):

- Signup took 515 ms with nothing onchain.
- The deposit address cost the relayer 0.0975 XLM and 2 XLM of sponsored reserve.
- A friendbot "exchange" paid 3 USDC ([6cbf931f…](https://stellar.expert/explorer/testnet/tx/6cbf931ffa3dba4c15e1ab901ff53caf71391beb358dc67280459a207a83b905)).
- The Durable Object swept it ([5a094760…](https://stellar.expert/explorer/testnet/tx/5a0947605bcb807191ba6a972434ae4ef825414cff488e44aa01a5dfcaf29e48))
  and deployed the account ([f7ad23a2…](https://stellar.expert/explorer/testnet/tx/f7ad23a26f55f29758246066272556822e244ece20496cd48b2aec4a2879d774)) 74 s later.

## What's next: expiry and renewal

A deposit address works until its allowance expires, at most the network's maximum entry TTL (~180 days; the testnet
address above until 2027-04-23). Home (`deposit-expires`) and `wallet_deposit_address` (`expires_at`) show that date.
G's key is gone and its master weight is 0, so the allowance cannot be renewed, and USDC sent after the expiry stays on
G for good.

The plan, not built (nothing changes for ~165 days, and it needs a migration):

1. Fourteen days before the expiry, the next GET or `wallet_deposit_address` creates a fresh G for the same `C…`.
2. The old G moves to a `deposit_history` table with its teardown XDR.
3. The Durable Object keeps sweeping it until its own expiry.
4. After that, once G is empty, it submits the teardown: `StellarOps.closeDeposit` returns the 2 XLM of reserve.
5. In the last 30 days the UI says "a new address replaces this on <date>", so senders who saved the old one are told.

Wallets that never come back keep their G and its 2 XLM until a janitor tears down expired, empty addresses.

## What the deployer must know

- **Migration** `0007_deposit_addresses.sql`: one new table, additive. The D1 migrations directory applies it on
  deploy.
- **No bindings or secrets to add.** The Durable Object's tick reads the existing `CHAIN`, `RELAYER_SECRET(S)` and
  `VAULT_KEY`. `DEPOSIT_ROUTER_ID` is an optional override: `off` disables the feature, and it is empty on pubnet.
- **No generated bindings**: the router is called with raw ScVals, like the onboarding router.
- `contracts/deployments/testnet.json` records v2 and marks v1 unused.
- Mainnet needs the same WASM deployed with the pubnet USDC SAC as the constructor token, then `DEPOSIT_ROUTER_ID`
  set. Not done, and not to be done without Kristjan's go after a testnet rehearsal.

## Risks

- **Liveness.** Nobody but us sweeps automatically, and only for 24 h after the address was shown. Funds stay safe on
  G until a sweep, and anyone may sweep (the router call is permissionless). An exchange withdrawal that arrives days
  later waits for the owner's next visit to Add money, or for `POST /api/wallet/sweep`.
- **Allowance expiry (~180 days, ledger 8,496,182 for the run above).** G's key is gone and its master weight is 0, so
  the allowance can never be renewed. **USDC sent after the expiry is stuck on G for good**: nobody can move it, and the
  teardown fails while G holds any. Re-registration means a fresh G. Mitigation before the expiry: show the countdown
  (`expires_at`), retire the address with the teardown (then later payments bounce at the sender, since G no longer
  exists), and issue a new one. None of that is automated yet.
- **Router TTL.** The instance and code were extended ~3 M ledgers today. They must be kept alive like the other shared
  contracts, or they archive (restorable, but sweeps fail until then). The binding's TTL equals the allowance's.
- **Reserve cost per wallet.** 2 XLM is locked per address until teardown, plus ~0.1 XLM rent and fees. A wallet that
  never comes back keeps the 2 XLM locked. Wallet-creation caps bound the total; creation is lazy, so only wallets
  that open Add money pay it.
- **Assets other than USDC.** G holds only a USDC trustline, so other assets fail at the sender. XLM sent to G cannot
  be swept by the router; it goes to the relayer at teardown.
- **Relayer contention.** The Durable Object and the Worker use the same relayer keys from different isolates. A
  `txBadSeq` is retried on the next relayer.
- **Trust in Nod at creation.** The service binds G to the session's wallet without a passkey signature. A malicious
  service could show an address bound elsewhere, and that holds equally for Nido's variant, because the UI shows
  whatever address the server says. After creation, nobody can redirect funds. `deposit(g)` on the router lets
  anyone check the binding.

## Compared with Nido #165, after the fact (orchestrator, 22:55 UTC)

Same idea, different spender. Nido approves the burner G's USDC to the wallet's own C and installs a signer-less sweep
policy on the C (the standard OpenZeppelin policy library, upgradable by a governance key); we approve it to an immutable
router that only knows how to move G into the C it was registered with. What ours can do that theirs cannot: create the
address on a page load with no passkey, and therefore **deposit-first signup**, binding an address to a planned C that
does not exist yet (a policy must be installed on a deployed account by its owner). What theirs has that ours lacks: the
ecosystem's policy framework instead of a contract of our own. Shared by both, in Nido's words: "the secret is gone, so
the allowance cannot be renewed; deposits after expiry cannot be claimed" (the rotation above). Adopting Nido's design
would be one to two days (rebuild the policy for our account build on soroban-sdk 29, install a rule per wallet with the
passkey, change provisioning and the watcher) and would lose deposit-first; CAP-72 (draft) would simplify both designs.
Stellar's own guide on paying contract accounts offers no classic-payment path to a C and no forwarding pattern, so the
gap this closes is real and undocumented; see docs/research/ecosystem-alignment.md.
