# Nod documentation

Start with the public product story:

- [README](../README.md) — what Nod does, the live hosts, and the proof links.
- [Pitch](PITCH.md) — the vocabulary and claims used in the site, deck, video, and submission.
- [Submission](SUBMISSION.md) — the portal answers and their evidence.
- [Spec](SPEC.md) — the product contract, acceptance tests, and decisions.

The engineering record is split by purpose:

- [Spikes](SPIKES.md) and [`spikes/`](spikes/) record the risky experiments and their results.
- [`research/`](research/) holds source-backed research and observations from the build.
- [`NEAR-INTENTS.md`](NEAR-INTENTS.md) records the cross-chain top-up integration and its evidence boundary.
- [`evidence/`](../evidence/) contains run receipts, screenshots, and explorer links.
- [Judge test path](../evidence/JUDGE-TEST-PATH.md) is the shortest route through the live testnet demo.

For maintenance, use [architecture decisions](BUILD-PLAN.md), [deployment](DEPLOY.md), [hostnames](DOMAIN.md), and the
[mainnet record](MAINNET.md). The [bootstrap funding table](mainnet-funding.md) is a historical reference for scripts.
Contributor rules live in [AGENTS.md](../AGENTS.md).

Developer setup, including the pinned TypeScript and oxlint servers for VS Code, Cursor, Zed and Neovim, is in
[development](development.md).

Research and spike reports are dated observations. They retain superseded assumptions where those explain an
experiment; the result reports and later receipts take precedence. Obsolete schedules and work queues are in Git
history. Private scratch under `.local/` is ignored and is not required to read these public docs.
