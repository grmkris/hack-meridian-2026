# Nod's living illustration

Eight-second silent loop: two routine payments leave the ledger; a larger payment waits on the sealed letter;
the engraved fingertip presses it; the payment leaves. All moving pieces return to the opening state before the
loop boundary. There is no scene crossfade.

The engravings and fonts come from the application's existing assets. `scripts/landing-loop.ts` prepares the
HyperFrames project in `.local/landing-film`, including a cutout of the seal plate's fingertip, then renders it with
HyperFrames 0.8.200 and GSAP 3.15.0. The delivery crop is 1600 × 760 at 30 fps, H.264/yuv420p, silent, with MP4 faststart.
The first frame is the still fallback. No animation library runs in the landing page.

```sh
heavy bun scripts/landing-loop.ts
npx --yes hyperframes@0.8.200 preview .local/landing-film --background
```

The source uses paused seekable timelines. The three rotation-pivot audit warnings are intentional: the coins
translate while turning around their own centers. Confirm motion and the loop with decoded frames after edits.
