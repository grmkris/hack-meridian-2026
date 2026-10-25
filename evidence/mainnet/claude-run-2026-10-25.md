# Mainnet run through claude.ai, 2026-10-25 18:39–18:59 UTC: every beat on pubnet

Kristjan's own wallet, his own passkey, the public claude.ai connector "Nod (mainnet)" at `https://trynod.si/mcp`
(release `9fc080f`), driven from his browser by the orchestrator session; Kristjan tapped the passkey for the consent
and for Bob. Network: Stellar pubnet. Explorer links are `https://stellar.expert/explorer/public/tx/<hash>`.

| beat | what happened | tx |
| ---- | ------------- | -- |
| consent | Claude connected with an allowance of 5 USDC until 2026-10-26 12:00 UTC; rule installed on the account | `f803994b1f0313b0c9fe81c51355eb51296b86992c65c70e2e04effa8d73d7eb` |
| overview | wallet `CDOTWV7AICM5WKEIKQ7HTJWIPJJVZDND55VK7NOLPB7BDC76YLTNY4HC`: 9.90 USDC, allowance 5.00 | – |
| brief 0.10 | `paid_resource_fetch` of the mainnet seller's market brief (XLM/USDC mid 0.1695577 at ledger 65,133,620); 1.00 USDC pulled from the wallet into Claude's pocket, 0.10 settled to the seller through OpenZeppelin Channels, fee 0.0160793 XLM paid by the facilitator `GA5SXMFJ…`; allowance 4.90 | pull `6485e55cd8f69d51b60f608bdc253d40c3d7ee02f9b86bcccd6cefbeeb08c7bb`, settlement `cb296cc3a539cfaf966d79fa3662e48e83e3f1fb01fe9be24b767d3c3c8dea58` (ledger 65,133,622) |
| Alice 2 | `contacts_search` → `payment_prepare` → `payment_execute`, memo "Lunch", inside the allowance, fee 0.0523491 XLM paid by relayer A; allowance 2.90 | `c8ee8b5ad7599b9db13a4dd551a918d55ecafc6de2f31c79a61fcc7edb1032cb` (ledger 65,133,637) |
| Bob 5 | above the 2.90 left → "needs your nod": claude.ai showed the approval URL (MCP URL request), Kristjan approved on `https://trynod.si/approve/pi_7a4ddcc0…` with his passkey; owner lane, allowance unchanged at 2.90, fee 0.001338 XLM paid by relayer A | `0339b8dd088b46d500de425d0afe8707ff6922186ef70070396323f2d3312e4f` (ledger 65,133,650, 18:47:15 UTC) |
| repeat | the same request with the same idempotency key returned the same payment `pi_7a4ddcc0…`, receipt `rc_18d2b21c…` and tx; Bob paid once | same |
| 4 USDC | `payment_prepare` with 2.90 left → awaiting approval `pi_6651d0d2…` (expires 19:18:56 UTC), nothing reserved or spent: grant remaining 2.90, reserved 0, spent 3.00; wallet 1.90 USDC, pocket 0.90 | – |
| Carol 1 | Carol `GCMSW7…` had no USDC trustline → owner lane: Kristjan approved on the approval page with his passkey (`pi_2c037ecb…`), then the claim link `https://trynod.si/claim/pi_2c037ecb…` was accepted by Nod's demo recipient key; trustline and payment in one transaction, memo "Happy birthday", fee 0.002101 XLM paid by Nod; allowance still 2.90 | `1fe4e852314ea638ed53ba79acebc60a129b587e0ef80c9b051d434aa01e68c6` (ledger 65,133,756, 18:56 UTC) |
| revoke | Kristjan pressed Revoke on the Connections page, then Remove rule with his passkey (18:57:59 UTC): connection and grant revoked, the allowance rule removed from the account on chain, the pocket's unspent 0.90 USDC swept back to the wallet; wallet 1.80 USDC (9.90 − 1.00 pull − 2 − 5 − 1 + 0.90) | remove `e17e15d5efd2f43e883073873ff9d5dc0333ea9dca318cea0f38a5c7678f04c9`, sweep `ab6d493d483f6ea5d560a9561ab7cdd2668b9d7597632023095a397ca1fd53dd` |
| refused | "Send Alice 0.50 USDC" after the revoke: Nod refused the call; claude.ai showed "Reconnect a connector to keep using it: Nod (mainnet)" and nothing left the wallet | – |

Observed in claude.ai: each tool was approved once with "Always allow"; the post-nod result for Bob came back to Claude
as a confirmed `payment_prepare`, which Claude described as unexpected ("I never got an approval link") before the owner
confirmed the nod; reported to the MCP-Apps session for the result wording. The "wants to open a URL" dialog for an
unapproved intent re-appears after "I'm done, continue" on this release; Decline ends it with an error-shaped result whose
text says nothing was paid (4a233ba returns the plain awaiting_approval result instead; on testnet since c54a331). After
Carol's claim landed, Claude still said "Nod lists Carol as not ready" because the post-nod result does not restate the
recipient's new readiness. Copy: the approval page says "they accept on the claim link first", the claim page says it
"opens once the wallet owner approves"; the claim page is right.
