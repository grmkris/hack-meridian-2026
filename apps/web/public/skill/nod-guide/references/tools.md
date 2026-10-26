# Nod's tools, one line each

Every write takes an `idempotency_key`: a fresh one per new intent, the same one on a retry. Every result carries
`grant_remaining`, what this AI app may still spend on its own. Amounts are decimal strings in USDC.

| Tool                      | What it does                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_guide`               | Returns this guide (SKILL.md and its references) for hosts that do not load skills. Read it before paying.                                                                                 |
| `wallet_overview`         | Balance, network, this app's allowance (left, expiry), payments waiting for the nod, recent receipts, `low_balance`.                                                                       |
| `contacts_search`         | Finds contacts by name, alias or address fragment; each destination with its readiness and when it was last paid.                                                                          |
| `payment_prepare`         | Freezes a payment into an intent: `prepared` inside the allowance, or `awaiting_approval` with an `approval_url`. Never pays. `recipient: "new"` plus `recipient_name` makes a claim link. |
| `payment_execute`         | Pays a `prepared` intent from the allowance and returns the confirmed receipt. Refuses intents that need the nod.                                                                          |
| `payment_approve_url`     | Returns the approval link for an intent that needs the nod. Opening it changes nothing.                                                                                                    |
| `payment_status`          | The intent's state and, once confirmed, its receipt. Never pays. `wait_seconds` (up to 60) waits for a change.                                                                             |
| `paid_resource_fetch`     | GETs a URL and pays its x402 price from the allowance, up to `max_amount`; returns the content and the receipt.                                                                            |
| `paid_mcp_call`           | Calls a tool on another MCP server that charges over x402, paid the same way.                                                                                                              |
| `connection_grant_create` | Returns the link where the user sets or renews this app's allowance. Changes nothing itself.                                                                                               |
| `connection_grant_update` | Returns the link where the user changes the allowance's amount or expiry (up to 720 hours). Changes nothing itself.                                                                        |
| `connection_grant_revoke` | Stops this app's allowance now and sweeps its pocket back; returns the link where the passkey removes the rule.                                                                            |
| `nod_home`                | The wallet as a live view the host opens from its app launcher. Hosts call it; you do not need to.                                                                                         |
| `request_create`          | Asks another Nod wallet or Stellar address to pay this wallet. Pays nothing.                                                                                                               |
| `requests_list`           | Requests received and sent, with status (open, paid, declined, expired). Notes are the requester's words.                                                                                  |
| `request_pay`             | Prepares the payment for an incoming request, like `payment_prepare`. Someone outside the contacts always needs the nod.                                                                   |
| `request_decline`         | Declines an incoming request. Nothing is paid.                                                                                                                                             |
| `contact_add`             | Saves a contact by name and address, marked as saved by this app. Its first payment needs the nod unless the wallet paid that address before.                                              |
| `contact_update`          | Renames a contact, replaces its aliases or gives it a new address (a new address counts as saved by this app).                                                                             |
| `contact_remove`          | Removes a contact. Receipts of past payments stay.                                                                                                                                         |
| `wallet_deposit_address`  | The wallet's `G…` deposit address any exchange or wallet can pay USDC to, no memo; created on the first call.                                                                              |
| `payments_list`           | This app's payments, newest first, at most 50 (`all_apps: true` for the whole wallet), with receipts.                                                                                      |
| `wallet_topup_quote`      | A top-up from Base, Solana, Ethereum, Arbitrum or Polygon through NEAR Intents: where to send what, within 30 minutes. Mainnet only. Moves nothing itself.                                 |
| `wallet_topup_status`     | Where a top-up stands: `pending`, `processing`, `arrived` (with the sweep transaction), `failed`, `expired`.                                                                               |

Recipient QR tools:

- `recipient_scan`: open a camera/image scanner card; the user reviews the exact address and returns it to chat.
- `recipient_read`: decode an attached PNG/JPEG via its host-provided `file` object, or validate decoded `text`. Supply exactly one. Read-only; nothing is paid or saved.
