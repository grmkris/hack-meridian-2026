# Wallet identity and approval recovery

Implementation and acceptance record, 27 October 2026. Merchant work is outside this change.

## Behaviour

- Approval, allowance, and revocation pages identify the target wallet by name, shortened address, and network.
- Login for an approval and the signing prompt request the target wallet's credential. General sign-in and wallet
  switching still allow discovery of the user's passkeys.
- Selecting another wallet shows the mismatch and offers another attempt. Cancelling restores the button and keeps
  the approval pending. An unsuccessful filtered login also offers an explicit all-passkeys fallback.
- The wallet menu supports rename, switch wallet, and sign-out. Failed saves and failed sign-outs remain visible and
  retryable. Switching clears the displayed wallet state after successful sign-out and starts passkey sign-in.
- Wallet names accept 1–40 characters and must contain non-whitespace text. Names are trimmed before storage.
- Interrupted person-link approvals appear in the wallet's pending inbox. Expired links cannot be approved.

The existing `wallets.name` field is authoritative; the authenticated rename endpoint is its writer. Approval
pages and session responses read it. No wallet, credential, address, balance, or connection migration is involved.
Renaming in Nod does not update a label already stored in a device's passkey manager.

The pending inbox derives from payment intents and claim links, with each query bounded to 50 rows. Diagnostics
accept enumerated ceremony events and log a wallet id and event kind for authenticated requests; they do not
accept arbitrary browser messages or passkey material. Signed-out ceremonies are not recorded by that endpoint.

## Investigation

The person-link approval previously passed an empty `allowCredentials` list to WebAuthn. With several resident
passkeys this offered unrelated wallets. The server still rejected the wrong signature, but the interface gave
little help identifying the right account. Allowance and link-revocation prompts had the same unrestricted list.
They now pass the target credential. This is a code and browser reproduction of the ambiguity, not attribution of
the user's specific historical incident to a Cloudflare request.

`bun scripts/site-e2e.ts local` initially timed out after wallet creation. Its screenshot showed a successfully
created, funded wallet: the assertion was waiting for the old “Home” heading. Navigation also expected the old
`/receipts` route. Updating these expectations to the current wallet shell and `/transactions`, and removing a
stale forced first-login rejection, made all ten steps pass without increasing timeouts.

## Verification and limits

- `heavy bun run check`: 386 tests passed, 16 skipped; format, lint, typecheck, contracts, and build passed.
- `approval-browser.test.ts`: native Chromium virtual authenticator, three resident credentials, two wrong-wallet
  sessions, cancellation, filtered retry, exactly one rule install, and reload without another install. The chain
  in this test is a fixture. Screenshots are written under `.local/wallet-identity/` from the repository root.
- `wallet-identity.test.ts`: session-scoped rename, blank-name rejection, unchanged address/passkey/balance,
  authenticated filtering and discovery, wrong-signature rejection, pending-link recovery, expiry, and event
  validation. Foldkit Scenes cover save failure and sign-out/sign-in recovery.
- `bun scripts/site-e2e.ts local`: ten successful steps through the local Worker backed by Stellar testnet. The
  last run created [this test wallet](https://stellar.expert/explorer/testnet/contract/CBRURP7XD33DBCO34RSAY6TO56REO7XN3SAHRZFB4RU7WKNC3ERWWIR7).
  Rename survived reload with the same address and 10.00 test USDC. Receipt: `.local/e2e/local/receipt.json`.
- `bun run smoke:local` and `bun run shots`: passed; phone and desktop screenshots inspected.
- Fixture-only wallet-menu stress check: six names across 320/390/1280px and 100%/200% text size, 36 combinations,
  no horizontal overflow; rename focus works. Names included long unbroken text, diacritics, CJK, emoji, and HTML-like
  text. The full name remains available in the expanded menu. No new motion or icon system was introduced.

CI installs the pinned Playwright Chromium headless shell before the full check. Local browser checks require
Chromium to run outside a sandbox that blocks its process operations. Hardware passkey managers and the user's
device still need release acceptance. This change has not been deployed or tested on mainnet.
