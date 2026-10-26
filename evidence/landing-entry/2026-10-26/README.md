# Landing entry and looping night flight

Release `aca87d320d125af5b6e825778431f3e68d10c1e7` is pushed and deployed to
[testnet](https://testnet.trynod.si) and [mainnet](https://trynod.si).

- The six-second H.264 loop blends the shot's last 1.5 seconds into its first 1.5 seconds, then wraps between adjacent
  source frames. The original source and `scripts/landing-loop.ts` retain the recipe. Playback has a pause control;
  reduced motion, Save-Data and autoplay refusal retain the still drawing.
- Connect wallet starts sign-in immediately. An unfinished attempt offers retry or explicit creation; cancellation
  never means a credential is absent and never registers a wallet. The name field appears only after choosing
  creation. Focus follows the entry state, names retain the API's 40-character limit, and invite gates remain enforced.
- Removed the example wallet card and moved connector setup to How it works. Transparent WebP artwork from the
  previous mobile Safari release remains in use.

The clean, pinned deployment checkout passed `heavy bun run check`: 334 TypeScript tests and 24 Rust tests, plus
format, generated-artifact checks, lint, typecheck, clippy and build. Both inspected Alchemy plans changed Web and
RELEASE only; no database change or Durable Object deletion, rename or transfer.

Local browser acceptance exercised real virtual WebAuthn registration and sign-in in Chromium, with independent
Node verification of the API payload's challenge, origin, RP hash, P-256 public key and signature. All API calls were
intercepted. WebKit tested unsupported-browser guidance and recovery UI; its Linux credential API is absent, so the
supported-browser UI paths use a rejecting stub. Scene tests reject an injected bug that automatically creates a
wallet after sign-in failure; restoring the code returns the focused 12-test suite to green.

Local Chromium and WebKit each passed seven media scenarios: phone, desktop, slow load, blocked autoplay, missing
video, reduced motion and Save-Data. Phone/desktop checks observe an actual time wrap and verify pause/resume. Six
chapter drawings pass pixel checks. A separate 320px/200%-text pass checked long errors, names, invite codes, focus,
connector contrast and the footer. These screenshots were inspected; the footer has no blank tail in a real viewport.

At both live URLs, health reports this release, 13 served assets hash to the deployment artifact, and phone media
checks pass in Chromium and WebKit. Live phone and desktop screenshots pass light, dark and reduced-motion checks.
The testnet HTTP smoke passes 9/9. Mainnet passes 8/9: the unchanged testnet-only counter check expects a contract
where mainnet intentionally returns `404 NotDeployed`. No real wallet or payment was created by these checks.

Physical iPhone Safari and its platform passkey prompt have not been tested on this box. The machine-readable details
are in `receipt.json`; screenshots remain under `.local/landing-shots/`.
