# Nod's surfaces, captured for the deck and the video

Session C, 2026-10-25. Phone is 390 × 844 at 2×, desktop 1440 × 900 at 2× (the landing's desktop shot at 1×);
`-phone-fold` is the first screen only. Driven by a headless Chromium with a CTAP2 virtual authenticator (the pattern
of `scripts/demo/lib/browser.ts`) and a DCR client honestly named **Demo AI app** (its consent page says "This app
registered itself; its name is not verified"). For the real claude.ai and Goblin screens see `evidence/mcp-apps/`.

## testnet.trynod.si (release 9a965a3, 19:58–19:59 UTC)

A throwaway testnet wallet `CCFGBIGVHAUEGFNXATDBYTKU42UMHTVYKNRX3GJ4Z2R4SFNHILDRZDEW` with the 10 testnet USDC every new
wallet gets; allowance 5 USDC until tomorrow 12:00 UTC.

| Surface | Files | What it shows |
| --- | --- | --- |
| Landing | `landing-*.jpg` | the signed-out home |
| Consent, step 1 | `consent-signin-*` | create a passkey wallet or sign in |
| Consent, step 2 | `consent-*` | "Demo AI app may spend up to 5.00 USDC on its own until tomorrow, 12:00 UTC. Larger payments need your passkey, every time." |
| Approval | `approval-*` | Bob 6 USDC, past the allowance: amount, recipient, who asked and its words, Nod pays the fee, the passkey button |
| Approval, paid | `approval-paid-*` | the same page after the passkey: [a17ce9c3…](https://stellar.expert/explorer/testnet/tx/a17ce9c3847935b0ea29c8d625eca21861e1982b8092b14801c5c06a10699f94) |
| Home | `home-*` | the two numbers: wallet 2.00 USDC; Demo AI app may still spend 3.00 of 5.00 (Alice 2 inside the allowance, [6d61353c…](https://stellar.expert/explorer/testnet/tx/6d61353ceada07e085daead43f466e2dfb02341d701ec69a167804bb5d315bce); Bob 6 by nod, outside it) |
| Connections | `connections-*` | the active allowance |
| Revoke, confirm | `connections-revoke-confirm-*` | the two steps spelled out before anything happens |
| Revoke, step 1 done | `connections-revoked-step-1-*` | "Nod has stopped signing for this AI app … One passkey tap removes the rule" |
| Revoke, step 2 | `revoke-step-2-*`, `revoke-done-*` | the passkey removes the rule: [3aeae03a…](https://stellar.expert/explorer/testnet/tx/3aeae03a8f66602a2155449a9342c33f93f2936e975e0037557eb0cc5e65db48) |
| Connections, after | `connections-revoked-*` | revoked, rule removed; the next tool call was refused (Unauthorized) |
| Receipts | `receipts-*` | both payments with their lanes |

## trynod.si (mainnet, 20:04 UTC)

Signed out only; no wallet was created on mainnet. `landing-*.jpg` and `consent-signin-*` (the "Stellar Mainnet" pill).

## cards/ (the MCP Apps card, harness)

The sealed `card.html` at 3473ee4 (live on testnet since) in the local test host (`bun run cards:shots`), 390 px, light
and dark, with fixture data (the hashes are not real): `payment-asked` (the call still held open by the chat for the
passkey), `payment-needs-nod`, `payment-receipt` ("Paid with your nod"), `payment-claim-link` ("Send this link"),
`payment-claim`, `wallet`, `purchase-paid`.
