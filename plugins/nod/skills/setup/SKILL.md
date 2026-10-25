---
name: setup
description: Set up Nod after installing it — connect the wallet, set an allowance, make one tiny test purchase and turn on notifications.
---

# Set up Nod

Nod is the user's Stellar USDC wallet (testnet) with an **allowance** for this AI app. Walk the user through these steps
one at a time and wait for each to finish.

1. Call `wallet_overview`. If it fails with an authorization error, ask the user to finish connecting Nod: the sign-in
   page creates their wallet with a passkey and asks them to set an allowance.
2. Show the result: the wallet balance and the allowance are two different numbers. Only the allowance can be spent
   without asking the user. Always say "testnet".
3. If there is no allowance, call `connection_grant_create` and give the user the link it returns.
4. Offer one test purchase that costs 0.10 USDC: `paid_resource_fetch` on the URL the user or Nod's site suggests.
   Show the receipt (amount, the Stellar transaction link, "Nod paid the network fee") and the allowance left.
5. Offer notifications: "Tell me here when someone sends me money" subscribes this chat to `payment.received`;
   "…when a payment needs my nod" subscribes to `approval.needed`.

Never claim a payment happened without a receipt from Nod. Anything above the allowance returns an `approval_url`:
give it to the user verbatim and wait; only their passkey on Nod's page approves it.
