import { AsyncData } from 'foldkit'
import { Command, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { Problem } from '../problem'
import { overview } from './fixtures'
import { AddressCopy, CopyAddress, LoadOverview, Message, OutMessage, OverviewData, init, update } from './home'

describe('Home', () => {
  test('entering the page loads the overview once, and again on the next visit', () => {
    story(
      update,
      given(init().model),
      message(Message.EnteredPage()),
      Command.expectExact(LoadOverview),
      Command.resolve(LoadOverview, Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
      model(nextModel => {
        expect(nextModel.overview).toEqual({ _tag: 'Success', data: overview })
      }),
      message(Message.EnteredPage()),
      model(nextModel => {
        expect(AsyncData.isRefreshing(nextModel.overview)).toBe(true)
      }),
      Command.resolve(LoadOverview, Message.SucceededLoadOverview({ overview, nowMs: 1792929600000 })),
    )
  })

  test('entering again while the overview is loading starts no second request', () => {
    story(
      update,
      given(modifyFields(init().model, { overview: () => OverviewData.Loading() })),
      message(Message.EnteredPage()),
      Command.expectNone(),
    )
  })

  test('a 401 ends the session instead of showing an error', () => {
    story(
      update,
      given(init().model),
      message(Message.FailedLoadOverview({ problem: Problem.SignedOut() })),
      expectOutMessage(OutMessage.EndedSession()),
    )
  })

  test('any other failure shows its sentence', () => {
    story(
      update,
      given(init().model),
      message(Message.FailedLoadOverview({ problem: Problem.Failed({ error: 'Soroban RPC is down.' }) })),
      model(nextModel => {
        expect(nextModel.overview).toEqual({ _tag: 'Failure', error: 'Soroban RPC is down.' })
      }),
    )
  })

  test('Add money: Copy address copies the wallet’s C… address and says so; a blocked clipboard says how instead', () => {
    const address = overview.wallet.contract_id
    const loaded = modifyFields(init().model, { overview: () => OverviewData.Success({ data: overview }) })
    story(
      update,
      given(loaded),
      message(Message.ClickedCopyAddress({ address })),
      Command.expectExact(CopyAddress({ address })),
      Command.resolve(CopyAddress, Message.CompletedCopyAddress()),
      model(nextModel => {
        expect(nextModel.addressCopy).toEqual(AddressCopy.Copied())
        expect(nextModel.overview).toEqual(loaded.overview)
      }),
    )
    story(
      update,
      given(loaded),
      message(Message.ClickedCopyAddress({ address })),
      Command.resolve(CopyAddress, Message.FailedCopyAddress()),
      model(nextModel => {
        expect(nextModel.addressCopy).toEqual(AddressCopy.Failed())
      }),
    )
  })
})
