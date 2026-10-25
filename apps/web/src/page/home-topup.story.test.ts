import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import type { TopupChain, TopupQuoteView } from '../backend'
import { Problem } from '../problem'
import { overview } from './fixtures'
import {
  AddMoneyTab,
  CheckTopup,
  LoadOverview,
  LoadTopupAssets,
  Message,
  OverviewData,
  QuoteTopup,
  Topup,
  TopupAssetsData,
  init,
  isTopupWaiting,
  update,
} from './home'

const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
const chains: ReadonlyArray<TopupChain> = [
  {
    chain: 'base',
    assets: [
      { id: BASE_USDC, symbol: 'USDC', decimals: 6 },
      { id: 'nep141:base.omft.near', symbol: 'ETH', decimals: 18 },
    ],
  },
  { chain: 'sol', assets: [{ id: 'nep141:sol.omft.near', symbol: 'SOL', decimals: 9 }] },
]
const quote: TopupQuoteView = {
  id: 'tq_1',
  pay_to: '0x5b1e2f0c9d4a7e6b3c8f1a2d4e6b8c0a1f3e5d7c',
  amount_in: '5',
  amount_out: '4.98',
  origin_chain: 'base',
  asset: 'USDC',
  deadline: '2026-10-25T22:35:00.000Z',
  status: 'pending',
  sweep_tx: null,
}
const loaded = modifyFields(init().model, { overview: () => OverviewData.Success({ data: overview }) })

describe('Add money from another chain', () => {
  test('opening the tab loads the chains once and picks the first chain and its first asset', () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedAddMoneyTab({ tab: AddMoneyTab.OtherChain() })),
      Command.expectExact(LoadTopupAssets),
      Command.resolve(LoadTopupAssets, Message.SucceededLoadTopupAssets({ chains })),
      model(next => {
        expect(next.addMoneyTab).toEqual(AddMoneyTab.OtherChain())
        expect(next.topupForm).toEqual({ chain: 'base', assetId: BASE_USDC, amount: '', refundTo: '' })
      }),
      message(Message.SelectedTopupChain({ chain: 'sol' })),
      model(next => {
        expect(next.topupForm.assetId).toBe('nep141:sol.omft.near')
      }),
    )
  })

  test('a second Get address while the quote runs asks nothing more', () => {
    story(
      update,
      given(modifyFields(loaded, { topup: () => Topup.Quoting() })),
      message(Message.SubmittedTopupQuote()),
      Command.expectNone(),
    )
  })

  test('Get address asks for a quote with the form as typed', () => {
    const ready = modifyFields(loaded, {
      topupAssets: () => TopupAssetsData.Success({ data: chains }),
      topupForm: () => ({
        chain: 'base',
        assetId: BASE_USDC,
        amount: ' 5 ',
        refundTo: '0x2a9c51f3b7d64e0c8a1f5d3b9e7c2a4f6d8b0e1c',
      }),
    })
    story(
      update,
      given(ready),
      message(Message.SubmittedTopupQuote()),
      Command.expectExact(QuoteTopup),
      Command.resolve(QuoteTopup, Message.SucceededQuoteTopup({ quote })),
      model(next => {
        expect(next.topup).toEqual(Topup.Quoted({ quote }))
        expect(isTopupWaiting(next)).toBe(true)
      }),
    )
  })

  test('each refresh reads a waiting quote; once it arrived the balance reloads and the reading stops', () => {
    const waiting = modifyFields(loaded, { topup: () => Topup.Quoted({ quote }) })
    story(
      update,
      given(waiting),
      message(Message.EnteredPage()),
      Command.expectExact(LoadOverview, CheckTopup),
      Command.resolve(LoadOverview, Message.SucceededLoadOverview({ overview })),
      Command.resolve(
        CheckTopup,
        Message.SucceededCheckTopup({ quote: { ...quote, status: 'arrived', sweep_tx: 'edc8f3b2' } }),
      ),
      Command.expectExact(LoadOverview),
      Command.resolve(LoadOverview, Message.SucceededLoadOverview({ overview })),
      model(next => {
        expect(isTopupWaiting(next)).toBe(false)
      }),
    )
  })

  test('topup_unavailable is kept as the failure the tab shows as "next here", not an alert', () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedAddMoneyTab({ tab: AddMoneyTab.OtherChain() })),
      Command.resolve(
        LoadTopupAssets,
        Message.FailedLoadTopupAssets({ problem: Problem.Failed({ error: 'topup_unavailable' }) }),
      ),
      model(next => {
        expect(next.topupAssets).toEqual(TopupAssetsData.Failure({ error: 'topup_unavailable' }))
      }),
    )
  })
})
