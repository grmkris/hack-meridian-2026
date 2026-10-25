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

## claude.ai (18:30–18:45 UTC, after the one-number deploy 9fc080f)

Connector "Nod (testnet)" added in claude.ai → Settings → Connectors → Add custom connector, signed in with Claude's
published identity (CIMD); consent page with one number (allowance + expiry, `nod-consent-one-number.jpg`), same wallet
CCS4FHIH… as in Goblin (a second AI app on it).

| # | What | Onchain |
|---|---|---|
| claude-01 | `wallet_overview` card: "Claude pays up to this on its own" (the host's name in the card) | — |
| claude-02 | 2 USDC to Bob inside the allowance: paid alone; the payment_prepare card flips to the receipt by polling | tx 9454…d333 (ledger 5385908) |
| claude-03 | 4 USDC with 3.00 left: claude.ai shows the 2026-07-28 URL request natively ("Nod (testnet) wants to open a URL") | — |
| claude-04 | approved with the passkey on Nod's page; Claude confirms the payment | [0d28f53a…](https://stellar.expert/explorer/testnet/tx/0d28f53ae201217621ec1554c3652e0ee85ba55d704a9decddf0ccf733e6bebe) (ledger 5385956) |

Found and fixed: when claude.ai ends the URL request before the user comes back (here while approving in another
tab), the lane returned an error, so Claude showed "Failed" and no card. Since the fix a declined/cancelled request
returns the plain result: the card keeps waiting for the nod and the model still gets the link.

## ChatGPT (18:55–19:13 UTC, testnet at c54a331)

Plugin "nod (testnet)" added in ChatGPT → Plugins → Add custom MCP server (https://testnet.trynod.si/mcp, OAuth) →
Create as a plugin. ChatGPT signs in with its published identity (CIMD, `https://chatgpt.com/oauth/client.json`) and speaks
protocol 2026-07-28 (`openai-mcp/1.0.0`): at connect it calls `server/discover`, `tools/list` and `events/list`, then reads
both `ui://` resources. Same wallet CCS4FHIH… (allowance 5.00 until 26 Oct 12:00 UTC). The chat-history sidebar is
cropped out of the screenshots.

| # | What | Onchain |
|---|---|---|
| chatgpt-01 | "Open plugin" opens Nod home (`nod_home`, the global entrypoint) as a full-page app, with ChatGPT's Work chat over it | — |
| chatgpt-02 | "Show my wallet": the wallet card inline; ChatGPT draws its own summary under it | — |
| chatgpt-03 | 0.50 USDC to Alice inside the allowance, after ChatGPT's "Allow once": paid alone, the card shows the receipt (allowance 4.50 left) | [3d676e73…](https://stellar.expert/explorer/testnet/tx/3d676e73a2c144ed4071dd086517474df0bb40a2afd918334ea8417c695d1e62) |
| chatgpt-04 | 6 USDC to Bob with 4.50 left: the card says "Needs your nod" (full address, the AI's reason marked unchecked, Approve with your passkey) | — |
| chatgpt-05 | approved with the passkey on Nod's page; the card polls `payment_status` and flips to the receipt; the allowance stays at 4.50 | [88973525…](https://stellar.expert/explorer/testnet/tx/8897352589059b4d53a17df1c4d038506c9f6b863c2379fc143dac460ba77eb2) (ledger 5386359) |
| chatgpt-06 | in a regular chat, "Tell me when someone sends me money on Nod" makes ChatGPT's own hourly Scheduled task (it polls the tools; no `events/subscribe`) | — |
| chatgpt-07 | in the Work chat, the same ask subscribes to `payment.received` by webhook (`connectors.api.openai.com`, verification challenge passed, 1 h lease). A 1 USDC treasury transfer is journaled by the chain watcher and delivered within 4 s; ChatGPT's task wakes and writes "You received 1.00 USDC … Sender GB4F…CIU5" with the Stellar Expert link | [c85e7693…](https://stellar.expert/explorer/testnet/tx/c85e7693d96237bb642a96a2a03c0e5415db39ae50ff87604bcc89d64eaaba95) |

Host notes: ChatGPT did not send `elicitation.url` in its client capabilities, so an over-allowance payment comes back as
the card's nod link (no MRTR URL request as in Goblin and claude.ai). It marks the card "CSP off" in developer mode.
