import { Command, click, expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { CounterData, FetchCounter, FetchHealth, Message, type Model, update, view } from './main'
import { health, loadedModel, loadingModel, reading } from './main.fixture'

describe('view', () => {
  test('shows loading for both panels before the Worker answers', () => {
    scene({ update, view }, given(loadingModel), expect(role('heading', { name: 'HackMeridian 2026' })).toExist())
  })

  test('shows the count and the contract link once loaded', () => {
    scene(
      { update, view },
      given(loadedModel),
      expect(text('7')).toExist(),
      expect(role('link', { name: 'CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2' })).toExist(),
      expect(text('testnet')).toExist(),
    )
  })

  test('shows a failed counter read as an alert', () => {
    const failed: Model = { ...loadedModel, counter: CounterData.Failure({ error: 'Soroban RPC took too long.' }) }
    scene({ update, view }, given(failed), expect(role('alert')).toHaveText('Soroban RPC took too long.'))
  })

  test('refresh shows the new count once both reads come back', () => {
    scene(
      { update, view },
      given(loadedModel),
      click(role('button', { name: 'Refresh' })),
      Command.resolve(FetchHealth, Message.SucceededFetchHealth({ health })),
      Command.resolve(FetchCounter, Message.SucceededFetchCounter({ reading: { ...reading, count: 8 } })),
      expect(text('8')).toExist(),
    )
  })
})
