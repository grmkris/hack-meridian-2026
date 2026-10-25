# Nod against the Stellar docs and the ecosystem (2026-10-25, 21:00–22:50 UTC)

Checked through the Stellar Raven MCP (official docs search) and live HTTP calls. Each line names its source.

## Aligned: documented patterns we use as documented

- **Onchain allowance for an agent.** The Agent CLI "Authority & Security Model" lists "Protocol Allowances (Onchain
  Spend Limits)" as the way to delegate: a capped, time-bound `approve`, spent with `transfer_from`; "the Stellar network
  rejects any transaction exceeding this cap"; it warns that "a key capable of signing a payment can sign for the
  account's full balance". Nod's AI-app allowance is the OpenZeppelin policy version of this; the deposit sweep is the
  pattern verbatim (approve with an expiration ledger, transfer_from). Sources:
  https://developers.stellar.org/docs/tools/cli/agent-cli/reference/authority-model,
  https://developers.stellar.org/docs/tools/cli/agent-cli/guides/delegate-spending.
- **Allowances expire by design.** The storage best-practices page gives "a SAC allowance that lives only until a given
  ledger" as the example of data that should die; the deposit address's ~180-day limit follows from the network's maximum
  entry TTL. Source: https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/persisting-data.
- **Smart accounts, context rules, policies, passkeys**: the smart-wallets guide describes OpenZeppelin accounts "where
  authorization runs through context rules, signers, and policies". Source:
  https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets.
- **Sponsored reserves and merge-to-reclaim** are the classic operations, used as listed. Source:
  https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations.
- **x402 fee sponsorship through a facilitator**, OpenZeppelin Channels named for mainnet, x402.org testnet only; the
  stellar-dev skill's x402 guide configures Channels. Source: Raven skill `stellar-dev.agentic-payments`, file x402.md.

## The gap we fill: no classic path from an exchange to a contract account

The guide "Send to and receive payments from Contract Accounts" shows every G→C payment as a SAC `transfer`
invocation; it never describes a classic `payment` to a C, and its only identification pattern is G plus memo (muxed id
for C senders). Exchanges only make classic payments, so a passkey wallet has no exchange-deposit path in the docs.
Nido's issue #165 and Nod's deposit address (docs/spikes/s8-deposit.md) are two answers; neither is documented upstream.
Source: https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-c-accounts.

## A limitation we can lift by the book: memos from a contract account

Since Protocol 23 (CAP-67) the SAC's `transfer` takes a `MuxedAddress`: "the way a memo does for a classic payment".
A contract account pays an exchange deposit address with a numeric memo id by building the M address from the G and the
id; the wallet should do it silently. Only `transfer` accepts a muxed address; the underlying G still needs the trustline.
This removes Nod's "warn before paying exchange addresses" limit and enables sending out through NEAR Intents, whose
Stellar deposit is a shared G plus a numeric memo (verified 22:30 UTC: `209891359`). Source:
https://developers.stellar.org/docs/tokens/stellar-asset-contract (Sending to a muxed address).

## x402 on Stellar: what we hit and where it is written down

- Hosted facilitators reject a contract-account payer (policy event, client signs as G): docs/research/x402-stellar.md;
  upstream x402 PRs #3399 (open, last touched 2026-09-08) and #3860 (open, 2026-10-21); the pocket is the bridge
  (docs/SPEC.md "Decisions log").
- Third-party sellers on pubnet (checked 2026-10-25 21:00 UTC): Stellar's own demo endpoint
  `https://stellar.org/x402-demo/api/protected/mainnet` is the one that settles (we paid it: `3a63573a…`); Nulucre's
  `stellar:pubnet` price names the **testnet** USDC contract `CBIELTK6…` so it cannot settle; RouteDock answers an MPP
  challenge, not x402; StellarSight's discovery index holds example entries on testnet; TollPay sells MCP tools.
  Evidence: evidence/mainnet/claude-run-2026-10-25.md.

## NEAR Intents (1Click) facts for the top-up

Stellar USDC and XLM are supported assets; payouts go only to an existing G with a trustline and no memo (our deposit
address); EVM addresses lowercase; requests need a browser User-Agent; no API key; no testnet. Live quotes and asset
ids: docs/NEAR-INTENTS.md.
