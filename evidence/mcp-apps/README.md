# Nod as an MCP Apps wallet: live host evidence

Goblin (goblin.surf, Kristjan's workspace), 2026-10-25 17:50–18:12 UTC, against testnet https://testnet.trynod.si
(release 3a63bd5: 0659ad8's MCP Apps, events, requests and 2026-07-28 lane, plus W1 and the cutover). Driven through
mytab in Kristjan's Chrome; the wallet's passkey is a DevTools virtual authenticator in that tab (testnet only).

| # | What | Onchain |
|---|---|---|
| 01–02 | `wallet_overview` renders the wallet card (`ui://nod/card/v1`): balance vs allowance, the meter, recent payments | — |
| 03 | 2 USDC to Bob is at the 1.00 nod line: on the 2026-07-28 lane the call returns an MRTR URL request, which Goblin draws as its own "finish a step on its site" card | — |
| 04 | Nod's approval page after the passkey: payment confirmed | [63a28bf9…](https://stellar.expert/explorer/testnet/tx/63a28bf9313214cf0be47aec5eb1b7de5076a913c265c9846fb3a253d89c78b8) |
| 05 | "Done, continue": Goblin retries with `requestState`, the lane returns the settled payment | same |
| 06 | MCP Events: `payment.received` subscribed by webhook; a 1 USDC treasury transfer seen by the chain watcher arrives as Nod's notice in #Personal | [091942b4…](https://stellar.expert/explorer/testnet/tx/091942b4b7becb61161308840e4a6b4b75fa2df01080ce0a1377fd26ea80497b) |
| 07 | A second agent (scripts/agent.ts, its own Nod wallet CA67…MZFN) asks for 1.50 USDC: `request.received` notice (no note in it) and the Request card from `requests_list` | — |
| 08 | `request_pay`: a requester outside the contacts takes the owner lane (`owner_only`) even inside the allowance; `approval.needed` notice; passkey; paid. The requester's poll then shows `request.answered` (paid) and `payment.received` | [93b32af0…](https://stellar.expert/explorer/testnet/tx/93b32af01b22d43c28870a2ff8641b405bcf82950be5109a07b830618b3186e0) |
| 09 | Nod home (`nod_home`, global entrypoint, `ui://nod/home/v1`) as a Goblin App page, live every 10 s | — |
