import { Option } from 'effect'
import { Command, Mount, click, expect, given, role, scene, selector } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { CopyConnectorUrl, Message, PlayNightFlight, init, update, view } from './welcome'

const landingAt = (connectorUrl: string) => init(Option.none(), connectorUrl).model

// The night flight decides in the browser whether to play; here it settles without playing.
const settled = Mount.resolve(PlayNightFlight, Message.SettledNightFlight({ playing: false }))

describe('the landing on each host', () => {
  for (const { badge, origin } of [
    { badge: 'Live', origin: 'https://trynod.si' },
    { badge: 'Sandbox', origin: 'https://testnet.trynod.si' },
  ]) {
    test(`${badge} keeps the connector on its own host`, () => {
      const connectorUrl = `${origin}/mcp`
      scene(
        { update, view },
        given(landingAt(connectorUrl)),
        expect(selector('.landing-network')).toHaveText(badge),
        expect(role('heading', { name: 'Why Nod' })).toExist(),
        expect(role('heading', { name: 'Connect your AI' })).toExist(),
        expect(role('heading', { name: 'You stay in control' })).toExist(),
        expect(selector('.landing-connector code')).toHaveText(connectorUrl),
        settled,
        click(role('button', { name: 'Copy connector URL' })),
        Command.resolve(CopyConnectorUrl({ url: connectorUrl }), Message.CompletedCopyConnectorUrl()),
        expect(role('button', { name: 'Copied. Paste it in Claude’s connectors' })).toExist(),
      )
    })
  }
})
