# Shorter landing, ready for end users

Release `d17644a90216829aded411539f89b75d1c1da706` is pushed to `main` and deployed to
[Sandbox](https://testnet.trynod.si) and [Live](https://trynod.si).

The landing now has four chapters: Why Nod, Connect your AI, You stay in control, and Pays people too. The duplicate
setup section, Proof on Stellar ledger, trustline badge, recovery paragraph, pause control, and technology footer
are removed. Both environments offer one connector action pointing at their own origin. Copy is shorter throughout.
On phones only the Why illustration is hidden, with tighter chapter spacing and supporting type. Desktop artwork,
typefaces, and composition stay intact. The six-second loop, alpha-mask artwork, reduced-motion and Save-Data handling,
and still-image fallback are retained.

## Validation

The clean authoritative deployment checkout passed `heavy bun run check` at the release commit: 334 TypeScript tests,
24 Rust tests, formatting, skills drift, generated artifacts, lint, typechecks, clippy and production build. Sixteen
opt-in TypeScript tests remain skipped. An isolated checkout also passed against the same committed integration base;
unrelated, uncommitted product-shell work in the shared checkout was preserved.

- Chromium and WebKit each passed all seven local media scenarios: phone, desktop, slow video, missing video,
  blocked autoplay, reduced motion, and Save-Data. Checks observe a natural playback wrap and sample rendered pixels
  to distinguish real line art from a missing image or a filled rectangle. Three chapter drawings show on mobile;
  all four show on desktop. The hero and dawn drawings remain.
- Local Chromium entry acceptance verified real virtual WebAuthn registration and subsequent sign-in, with independent
  Node verification of the challenge, origin, RP hash, public key, and assertion signature. The relying-party domain
  is `localhost`; numeric loopback addresses cannot be used for this ceremony. All API requests were intercepted.
- WebKit exercised entry, recovery, unsupported-browser guidance, and network failure. Linux WebKit lacks the platform
  credential API, so supported-browser UI paths used a rejecting credential stub. No real wallet or payment was created.
- The 320px/390px/1440px stress check passed at 200% root text size with a long error and a long wallet name. It found
  and fixed top-bar clipping by allowing the bar to wrap. Inputs and buttons remain reachable and at least 44px tall.
- Both URLs report the exact release. Twelve served assets per environment match the deployment build by SHA-256.
  Chromium and WebKit phone checks pass on each live URL. Mainnet screenshots cover 320px, phone, tablet, laptop,
  desktop, and wide screens, including phone/desktop dark and reduced-motion variants.
- Testnet HTTP smoke passes 9/9. Mainnet is 8/9 with exit 1 solely because the testnet counter probe expects a contract
  on mainnet, which intentionally answers `404 NotDeployed`. The shell, health, protected API and OAuth discovery
  checks pass. This receipt does not label that full mainnet smoke green.

Both Alchemy plans changed Web and RELEASE only. WalletDb and the Durable Object bindings were unchanged;
deploy logs report no deleted, renamed, transferred, or new Durable Object classes. Deployment order was testnet,
live verification, then mainnet. The deployment checkout remains clean at the product release.

## Interface review

Full review of the signed-out landing and wallet entry only, using Foldkit and its existing plain CSS. This applies
frontend-design, apple-design, make-interfaces-feel-better, and the relevant break-ui cases.

| Category | Evidence | Result |
| --- | --- | --- |
| Typography | Live phone/desktop screenshots, 200% root text, long error/name | Shorter copy; readable wrap without clipped controls |
| Surfaces | Existing CSS tokens, primary/quiet buttons, 44px target assertions | Existing treatment retained; no added surface system |
| Animation | Natural loop checks, seven fallback scenarios in each engine | Loop retained; removed manual control; still art on refusal |
| Icons | Existing decorative etchings, alpha-mask pixel checks | Remaining drawings render; mobile Why intentionally absent |
| Performance | Build and request assertions for reduced motion/Save-Data | Removed proof asset from built CSS; no video request in either mode |

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| Medium | `apps/web/src/landing.css:169` | At 320px and 200% text the top-bar source link clipped | Flex children wrap | Keep enlarged-text navigation reachable |
| Low | `apps/web/src/landing.css:723` | Large mobile chapter spacing and Why art before text | Smaller gaps/supporting type; mobile Why art hidden | Let the benefits appear sooner |
| Low | `apps/web/src/page/landing-copy.ts` | Repeated setup and technical proof/jargon | Four shorter end-user chapters | Reduce reading and decision overhead |

Considered and rejected: removing all mobile drawings (the brief targets only Why), changing the desktop identity
(the existing composition is intentional), and adding replacement animation controls (the approved plan removes them).
No remaining actionable polish findings in the inspected scope. Physical iPhone Safari, its platform passkey prompt,
and frame-by-frame motion review at 10% playback speed were not verified. Browser media tests verify looping and
fallback behavior; the video asset itself was not changed in this release.

Machine-readable evidence is in `receipt.json`. Live screenshots are in
`/srv/cache/hm26/deploy-testnet/.local/landing-shots/`; local stress screenshots are in `.local/landing-trim/`.
