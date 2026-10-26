# Architecture decisions from the build

The build plan was completed on 25 October 2026. This page keeps the architecture references used by the code;
obsolete work queues, agent assignments, and the draft interface have been removed. See the [README architecture](../README.md#architecture)
for the system overview and [SPEC.md](SPEC.md#decisions-log) for the decisions that changed the original scope.

## Boundaries

- The browser uses the [HTTP API contract](../packages/api/src/index.ts). Secrets, signing, and chain SDK calls stay
  in the Worker and [`packages/stellar`](../packages/stellar/).
- The implemented [`Chain` service](../packages/protocol/src/chain.ts) is the contract between the wallet service and
  the chain package. It uses typed Effect operations and separate prepare/finalize steps for passkey approvals.
- A wallet's Durable Object coordinates payment intents. D1 stores wallet, connection, grant, intent, and receipt data.
  OAuth storage uses a separate Durable Object.
- The owner's passkey controls the OpenZeppelin account. Each AI connection gets its own expiring spending rule.
  The [S1 results](spikes/s1.md) prove the authority model, including a forced over-limit rejection.
- Hosted x402 facilitators take a classic account payer. A connection's pocket receives funds under the same spending
  rule, then pays the seller. [S2](spikes/s2.md) and [S5](spikes/s5.md) record the pull, settlement, and revoke evidence.
- The [onboarding router](../contracts/onboard/) combines trustline creation and payment.
  The [deposit router](../contracts/deposit/) binds a classic deposit address to its destination wallet.
- The [Alchemy stack](../apps/web/alchemy.run.ts) declares local, testnet, and mainnet stages. Use the
  [deployment procedure](DEPLOY.md) and the authoritative deployment checkout.

## Evidence

[Spike results](SPIKES.md) retain the experiments, version pins, and transaction links. Fee and TTL observations
there are dated measurements. Current values come from the running stage's `/api/health` and chain reads.
The [judge path](../evidence/JUDGE-TEST-PATH.md) links the product rehearsal; the
[mainnet record](MAINNET.md) links the real-money flow.
