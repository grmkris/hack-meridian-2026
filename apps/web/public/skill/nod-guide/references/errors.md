# Nod's error codes and what to do

An error result carries a `code`, a `message` and a `recovery` sentence. Follow the recovery sentence. Report the
message as Nod gave it; never replace it with a reason of your own.

| Code                   | When                                                                                         | What to do                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambiguous_recipient`  | More than one contact matches the name.                                                      | Show the user the matches, with the name and the last characters of each address, and ask which one. Never pick one yourself.                                     |
| `no_contact`           | No contact matches the name and no address was given.                                        | Ask the user for the person's Stellar address. If the person has no wallet, prepare the payment with `recipient: "new"` and `recipient_name` to get a claim link. |
| `account_missing`      | The address does not exist on this network.                                                  | Do not retry. Tell the user, and ask for another address or offer a claim link (`recipient: "new"`).                                                              |
| `memo_unsupported`     | The address needs a memo (an exchange deposit address).                                      | Nod cannot pay addresses that need a memo yet. Ask the user for an address without a memo, such as their own wallet's.                                            |
| `payments_paused`      | Nod has paused payments for everyone.                                                        | Nothing was paid. Tell the user and try again later. Revoking still works.                                                                                        |
| `revoked`              | The user revoked this AI app.                                                                | Stop paying. If the user wants you to pay again, they reconnect Nod and set a new allowance.                                                                      |
| `no_allowance`         | This AI app has no live allowance (none yet, or it expired).                                 | Offer the link from `connection_grant_create` so the user can set one. Until then, every payment needs the user's nod.                                            |
| `idempotency_conflict` | The key was used before with different arguments.                                            | Retrying the same payment: send exactly the same arguments with the same key. A new payment: use a new key.                                                       |
| `upstream_unavailable` | Stellar, a facilitator or a seller did not answer.                                           | Do not assume it failed. If there is a `payment_id`, read `payment_status` first; then retry with the same key in a minute.                                       |
| `topup_unavailable`    | Top-ups from another chain are not available here (testnet, or NEAR Intents did not answer). | Offer the deposit address (`wallet_deposit_address`) instead, or try the top-up again later on mainnet.                                                           |
| `invalid_input`        | An argument is missing or malformed.                                                         | Correct what the message names, then call again with a new idempotency_key.                                                                                       |
| `not_found`            | The id (payment, request or contact) is unknown.                                             | Look the id up again (payments_list, requests_list or contacts_search) and call with one from the answer.                                                         |

The sentences for the ten payment codes as data, for code that shows or checks them:

```json
{
  "ambiguous_recipient": "Show the user the matches, with the name and the last characters of each address, and ask which one. Never pick one yourself.",
  "no_contact": "Ask the user for the person's Stellar address. If the person has no wallet, prepare the payment with recipient \"new\" and recipient_name to get a claim link.",
  "account_missing": "Do not retry. Tell the user, and ask for another address or offer a claim link (recipient \"new\").",
  "memo_unsupported": "Nod cannot pay addresses that need a memo yet. Ask the user for an address without a memo, such as their own wallet's.",
  "payments_paused": "Nothing was paid. Tell the user and try again later. Revoking still works.",
  "revoked": "Stop paying. If the user wants you to pay again, they reconnect Nod and set a new allowance.",
  "no_allowance": "Offer the link from connection_grant_create so the user can set one. Until then, every payment needs the user's nod.",
  "idempotency_conflict": "Retrying the same payment: send exactly the same arguments with the same key. A new payment: use a new key.",
  "upstream_unavailable": "Do not assume it failed. If there is a payment_id, read payment_status first; then retry with the same key in a minute.",
  "topup_unavailable": "Offer the deposit address (wallet_deposit_address) instead, or try the top-up again later on mainnet."
}
```
