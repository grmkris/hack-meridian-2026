# Payment-and-approval landing film

The old flying-bird video is replaced in the hero by an eight-second engraved payment scene. Two small payments
move through; a larger payment stops on a sealed letter, waits for the fingerprint press, then leaves. The loop
returns to its opening composition without a crossfade. The 1600 × 760 H.264/yuv420p MP4 is 574,768 bytes, silent,
and faststart. The decoded first/last frames differ by a mean of 0.316 per channel out of 255 (encoding noise).
The editable source and reproduction recipe are in `scripts/landing-film` and `scripts/landing-loop.ts`.

The hero exposes **Sign in with passkey** and **Create wallet** immediately. Its video sits beside the heading on
large screens and above it on phones. A matching still renders before playback and when playback is unwanted or
unavailable. The existing muted/inline playback, slow-load behavior, alpha-mask chapter artwork, reduced-motion,
and Save-Data behavior are retained.

## Local evidence

- Clean integration snapshot: `heavy bun run check`, exit 0; 365 TypeScript tests passed, 16 live tests skipped,
  24 Rust tests passed; formatting, generated-artifact checks, lint, typecheck, clippy and build passed.
- Chromium and Linux WebKit: seven media cases each (phone, desktop, slow, blocked, missing, reduced, Save-Data).
  Phone/desktop observe a real playback time wrap. Every chapter drawing passes pixel checks.
- Chromium virtual WebAuthn: registration and return sign-in, independently verified P-256 signature, challenge,
  origin and RP hash; unsupported browser and network-failure recovery also pass. API calls are intercepted.
- 320px at 100% and 200% text: long wallet name, creation, return focus, controls at least 44px, no horizontal
  overflow. Phone and desktop screenshots were visually inspected.
- HyperFrames checks pass. Three rotation-pivot warnings are intentional simultaneous coin travel and rotation.
  Source snapshots, decoded endpoints and final video frames were inspected.

## Interface polish review

Full scope: signed-out hero and wallet entry; Foldkit with the existing CSS. Typography and wrapping, two button
surfaces, focus/disabled/creation/recovery states, video motion, and media loading were inspected. The introduced
artwork has no interactive icons. No actionable polish findings remain in this scope. Physical iPhone Safari and
its platform passkey prompt are not verified by these local checks.

The artwork stays beside the copy on desktop to keep the approval visible. A centered card around it was rejected
because it would separate the engraving from the existing page. A loop dissolve was rejected because it causes the
old ghosted transition. A new browser animation dependency was rejected: the page only plays the rendered MP4.

Machine-readable results are in `local-receipt.json`. Deployment verification is recorded separately.

## Deployment evidence

Both `https://testnet.trynod.si` and `https://trynod.si` serve release
`ef7fba660efeeab36d8e8ac662ad1dcc42e8783e`. This removes the obsolete bird MP4s in addition to shipping the new
film and wallet entry. The release passed `heavy bun run check` in the clean canonical deployment checkout
(`/srv/cache/hm26/deploy-testnet`) before deployment. Its log is `/tmp/nod-approval-deploy-check.log`.

The inspected Alchemy plans changed only Web and its RELEASE binding. Both deployments completed successfully;
the database and other bindings were no-ops, with no deleted, renamed, transferred, or new Durable Object classes.

`live-readback.json` records both health releases and matching SHA256 hashes for the served MP4 and still. The live
Chromium checks found both wallet buttons, the eight-second muted inline looping video, and no browser errors at
phone and desktop sizes. Live phone and desktop screenshots were visually inspected.

- `smoke-testnet.json`: 9/9 checks passed.
- `smoke-mainnet.json`: 8/9 passed; the counter check returned the expected `NotDeployed` response because the demo
  counter is testnet-only. The generic smoke command therefore exits 1 on mainnet; this is not an all-green smoke.

No live wallet creation or payment was performed. Physical iPhone Safari was not retested. The local WebKit media
matrix and virtual WebAuthn evidence above cover browser behavior, not an actual iPhone or a live passkey session.
This evidence-only update does not require redeploying; the deployed code remains pinned to `ef7fba6`.
