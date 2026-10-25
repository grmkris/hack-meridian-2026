import { Option } from 'effect'
import { Mount, expect, given, role, scene, selector, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Message, PlayNightFlight, init, update, view } from './welcome'

const landingAt = (connectorUrl: string) => init(Option.none(), connectorUrl).model

// The night flight decides in the browser whether to play; here it settles without playing.
const settled = Mount.resolve(PlayNightFlight, Message.SettledNightFlight({ playing: false }))

describe('the landing on each host', () => {
  test('on trynod.si it says mainnet and sends Try it to the sandbox', () => {
    scene(
      { update, view },
      given(landingAt('https://trynod.si/mcp')),
      expect(selector('.landing-network')).toHaveText('Stellar mainnet'),
      expect(role('heading', { name: 'Why Nod' })).toExist(),
      expect(text('https://testnet.trynod.si/mcp')).toExist(),
      expect(role('link', { name: 'Watch a sample agent run on Nod’s own demo wallet' })).toHaveAttr(
        'href',
        'https://testnet.trynod.si/sample',
      ),
      expect(role('link', { name: 'c8ee8b5a' })).toHaveAttr(
        'href',
        'https://stellar.expert/explorer/public/tx/c8ee8b5ad7599b9db13a4dd551a918d55ecafc6de2f31c79a61fcc7edb1032cb',
      ),
      settled,
    )
  })

  test('on the sandbox it says testnet and keeps its own connector and sample', () => {
    scene(
      { update, view },
      given(landingAt('https://testnet.trynod.si/mcp')),
      expect(selector('.landing-network')).toHaveText('Stellar testnet'),
      expect(role('link', { name: 'Watch a sample agent run on Nod’s own demo wallet' })).toHaveAttr('href', '/sample'),
      expect(role('link', { name: '3daf4b00' })).toHaveAttr(
        'href',
        'https://stellar.expert/explorer/testnet/tx/3daf4b000cb58ad1bbef3629c13a02d44403c4b690dd51815020cbc89723b42a',
      ),
      settled,
    )
  })
})
