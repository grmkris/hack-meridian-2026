# Three conversations, annotated

Results are shortened to the fields that matter. Keys and ids are examples.

## 1. Pay Alice inside the allowance

> **User:** Send Alice 2 USDC for lunch.

1. `contacts_search { "query": "Alice" }` → one contact, Alice, destination `CCHE…SO4Q`, readiness `usdc_ready`,
   `grant_remaining: "4.90"`.
   _One match, ready to receive, and 2 is inside 4.90: no question to ask._
2. `payment_prepare { "recipient": "Alice", "amount": "2", "reason": "Lunch", "idempotency_key": "lunch-alice-1" }` →
   `status: "prepared"`, `lane: "autonomous"`, `payment_id: "pi_…"`.
   _Prepared inside the allowance. The user decided when they set it, so do not ask again._
3. `payment_execute { "payment_id": "pi_…", "idempotency_key": "lunch-alice-1" }` → `status: "confirmed"`, receipt with
   `tx_hash`, `explorer_url`, `fee_paid_by: "relayer"`, `grant_remaining: "2.90"`.

> **Assistant:** Paid Alice 2 USDC on Stellar Testnet. Nod paid the network fee. You can see it here: (explorer link).
> I can spend 2.90 more on my own until tomorrow 12:00 UTC.

_If the answer to step 3 is lost, call `payment_execute` again with the same key: you get the same receipt and Alice is
paid once._

## 2. Pay someone who is not on Stellar

> **User:** Send 1 USDC to Jan. He doesn't have a wallet.

1. `contacts_search { "query": "Jan" }` → no contacts.
   _No contact and no address. Do not guess one._
2. `payment_prepare { "recipient": "new", "recipient_name": "Jan", "amount": "1", "idempotency_key": "jan-1" }` →
   `status: "prepared"`, `claim_url: "https://…/claim/cl_…"`, `next_step`: send Jan the link; nothing is paid until he
   claims.
3. Give the user the `claim_url` verbatim to send to Jan.

> **Assistant:** Here is a link for Jan: (claim_url). When he opens it he can create a Nod wallet with a passkey, sign
> in, or paste a Stellar address, and the 1 USDC goes there from my allowance. Nothing leaves your wallet until he
> claims it, and an unclaimed link expires.

4. Later, when the user asks: `payment_status { "payment_id": "cl_…" }` → `confirmed`, with the transaction.

_Past the allowance, the same request comes back `awaiting_approval` with an `approval_url`. After the user's nod the
link they send is an allowance for that one person: exactly the amount, valid seven days, its key only in the link._

## 3. Top up when the wallet is low

> **User:** Buy the market brief, then pay Bob 3 USDC.

1. `wallet_overview {}` → `balances.usdc: "1.20"`, `grant.remaining: "5.00"`, `low_balance: true`, network Stellar
   Mainnet.
   _The wallet holds less than the allowance. Bob's 3 USDC would fail for lack of funds, so offer money first._

> **Assistant:** Your Nod wallet on Stellar Mainnet holds 1.20 USDC, not enough for Bob's 3. You can add USDC from an
> exchange or wallet to your deposit address, or from another chain. Which chain do you have funds on, and what is your
> address there for a refund?

> **User:** Base, USDC. My address is 0x4838…5f97.

2. `wallet_topup_quote { "origin_chain": "base", "asset": "USDC", "amount": "5", "refund_address": "0x4838…5f97",
   "idempotency_key": "topup-1" }` → `id: "tp_123"`, `pay_to: "0x…"`, `amount_out: "4.98"`, `deadline` in 30 minutes,
   `status: "pending"`.

3. Without asking the user for another prompt, use the host's MCP Events capability to set up the all-events wallet
   monitor described in `SKILL.md`. Reuse it for this top-up; if it is not available, add `topup.arrived` and
   `topup.expired`, both filtered with `arguments: { "topup_id": "tp_123" }`. The host supplies the webhook and
   signing secret. Respect host-required confirmation; claim monitoring only after setup succeeds.
4. Immediately call `wallet_topup_status { "id": "tp_123" }` to cover an arrival during setup. If still pending and
   monitoring was confirmed:

> **Assistant:** Send 5 USDC on Base to (pay_to) within 30 minutes. About 4.98 USDC arrives in your Nod wallet, usually
> within a minute or two. I've set up an arrival notification for this top-up. If the swap cannot finish, it is
> refunded to your Base address.

5. On `topup.arrived` for `tp_123`, call `wallet_topup_status { "id": "tp_123" }` → `status: "arrived"`,
   `arrived_amount`, `sweep_tx`; then `wallet_overview` for the current balance and allowance. Report the actual
   received amount and transaction. Stop only a scoped top-up monitor; keep the all-events wallet monitor. If the result is `failed` or `expired`, report it
   and stop instead; do not retry a new quote without the user's request.
6. Continue the already-requested market brief and Bob payment through the usual allowance and approval flow.
   Check any existing payment before retrying; a duplicate event must not pay Bob twice.

_If the host cannot subscribe, call `wallet_topup_status` every 10 seconds during the active turn for up to 10 minutes.
Say when you stop waiting. Do not claim an arrival notification was set up. There is no `topup.failed` event._

_Never ask for a private key or seed phrase to move the user's funds; the user sends from their own wallet._
