import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { FetchCounter, FetchHealth, Message, update } from './main'
import { health, loadedModel, loadingModel, reading } from './main.fixture'

describe('update', () => {
  test('both fetches succeeding fill the panels', () => {
    story(
      update,
      given(loadingModel),
      message(Message.SucceededFetchHealth({ health })),
      message(Message.SucceededFetchCounter({ reading })),
      model(nextModel => {
        expect(nextModel.health).toEqual({ _tag: 'Success', data: health })
        expect(nextModel.counter).toEqual({ _tag: 'Success', data: reading })
      }),
    )
  })

  test('a failed counter read keeps its words for the view', () => {
    story(
      update,
      given(loadingModel),
      message(Message.FailedFetchCounter({ error: 'No counter contract is configured on local.' })),
      model(nextModel => {
        expect(nextModel.counter).toEqual({ _tag: 'Failure', error: 'No counter contract is configured on local.' })
      }),
    )
  })

  test('refresh revalidates loaded data and refetches both', () => {
    story(
      update,
      given(loadedModel),
      message(Message.ClickedRefresh()),
      model(nextModel => {
        expect(AsyncData.isRefreshing(nextModel.health)).toBe(true)
        expect(AsyncData.isRefreshing(nextModel.counter)).toBe(true)
      }),
      Command.resolve(FetchHealth, Message.SucceededFetchHealth({ health })),
      Command.resolve(FetchCounter, Message.SucceededFetchCounter({ reading: { ...reading, count: 8 } })),
      model(nextModel => {
        expect(nextModel.counter).toEqual({ _tag: 'Success', data: { ...reading, count: 8 } })
      }),
    )
  })

  test('refresh while both are loading starts nothing new', () => {
    story(
      update,
      given(loadingModel),
      message(Message.ClickedRefresh()),
      Command.expectNone(),
      model(nextModel => {
        expect(nextModel).toEqual(loadingModel)
      }),
    )
  })
})
