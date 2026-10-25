import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, Runtime, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Button } from '@foldkit/ui'
import { CounterReading, Health } from '@hm/api'

import { withApi } from './api'

// MODEL

export const HealthData = AsyncData.Schema(Health, Schema.String)
export const CounterData = AsyncData.Schema(CounterReading, Schema.String)

export const Model = Schema.Struct({
  health: HealthData.schema,
  counter: CounterData.schema,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedRefresh: {},
  SucceededFetchHealth: { health: Health },
  FailedFetchHealth: { error: Schema.String },
  SucceededFetchCounter: { reading: CounterReading },
  FailedFetchCounter: { error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const UNREACHABLE = 'The Worker did not answer. Check that the stage is running and retry.'

export const FetchHealth = Command.define('FetchHealth', {
  messages: [Message.SucceededFetchHealth, Message.FailedFetchHealth],
  execute: withApi(client => client.system.health()).pipe(
    Effect.map(health => Message.SucceededFetchHealth({ health })),
    Effect.orElseSucceed(() => Message.FailedFetchHealth({ error: UNREACHABLE })),
  ),
})

export const FetchCounter = Command.define('FetchCounter', {
  messages: [Message.SucceededFetchCounter, Message.FailedFetchCounter],
  execute: withApi(client => client.counter.read()).pipe(
    Effect.map(reading => Message.SucceededFetchCounter({ reading })),
    Effect.catchTags({
      NotDeployed: ({ error }) => Effect.succeed(Message.FailedFetchCounter({ error })),
      ChainUnavailable: ({ error }) => Effect.succeed(Message.FailedFetchCounter({ error })),
    }),
    Effect.orElseSucceed(() => Message.FailedFetchCounter({ error: UNREACHABLE })),
  ),
})

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { health: HealthData.Loading(), counter: CounterData.Loading() },
  commands: [FetchHealth(), FetchCounter()],
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedRefresh: () => {
      const maybeHealth = AsyncData.revalidateOrLoad(model.health)
      const maybeCounter = AsyncData.revalidateOrLoad(model.counter)
      return {
        model: modifyFields(model, {
          health: health => Option.getOrElse(maybeHealth, () => health),
          counter: counter => Option.getOrElse(maybeCounter, () => counter),
        }),
        commands: Array.getSomes([Option.as(maybeHealth, FetchHealth()), Option.as(maybeCounter, FetchCounter())]),
      }
    },
    SucceededFetchHealth: ({ health }) => ({
      model: modifyFields(model, { health: () => HealthData.Success({ data: health }) }),
    }),
    FailedFetchHealth: ({ error }) => ({
      model: modifyFields(model, { health: () => HealthData.Failure({ error }) }),
    }),
    SucceededFetchCounter: ({ reading }) => ({
      model: modifyFields(model, { counter: () => CounterData.Success({ data: reading }) }),
    }),
    FailedFetchCounter: ({ error }) => ({
      model: modifyFields(model, { counter: () => CounterData.Failure({ error }) }),
    }),
  })

// VIEW

const explorerUrl = (reading: CounterReading) =>
  `https://stellar.expert/explorer/${reading.network}/contract/${reading.contractId}`

const field = (label: string, value: string, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex items-baseline justify-between gap-4 py-2')],
    [
      h.dt([h.Class('text-sm text-zinc-500')], [label]),
      h.dd([h.Class('min-w-0 truncate font-mono text-sm text-zinc-900')], [value]),
    ],
  )

const panel = (title: string, body: ReadonlyArray<Html>, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class('rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm')],
    [h.h2([h.Class('mb-2 text-base font-semibold text-zinc-900')], [title]), ...body],
  )

const pending = (h: HtmlBuilder<Message>) => [h.p([h.Class('py-2 text-sm text-zinc-500')], ['Loading…'])]

const failed = (error: string, h: HtmlBuilder<Message>) => [
  h.p([h.Role('alert'), h.Class('py-2 text-sm text-red-700')], [error]),
]

const healthView = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    'Worker',
    AsyncData.matchData(model.health, {
      onEmpty: () => pending(h),
      onFailure: error => failed(error, h),
      onData: health => [
        h.dl(
          [h.Class('divide-y divide-zinc-100')],
          [
            field('Stage', health.stage, h),
            field('Release', health.release.slice(0, 12), h),
            field('Network', health.network, h),
          ],
        ),
      ],
    }),
    h,
  )

const counterView = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    'Counter contract',
    AsyncData.matchData(model.counter, {
      onEmpty: () => pending(h),
      onFailure: error => failed(error, h),
      onData: reading => [
        h.p([h.Class('py-2 text-5xl font-semibold tabular-nums text-zinc-900')], [reading.count.toString()]),
        h.dl([h.Class('divide-y divide-zinc-100')], [field('Network', reading.network, h)]),
        h.a(
          [
            h.Href(explorerUrl(reading)),
            h.Target('_blank'),
            h.Rel('noreferrer'),
            h.Class('mt-2 inline-block break-all font-mono text-xs text-indigo-700 underline'),
          ],
          [reading.contractId],
        ),
      ],
    }),
    h,
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'HackMeridian 2026',
  body: h.main(
    [h.Class('mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10')],
    [
      h.header(
        [h.Class('flex items-center justify-between gap-4')],
        [
          h.div(
            [],
            [
              h.h1([h.Class('text-2xl font-semibold text-zinc-900')], ['HackMeridian 2026']),
              h.p([h.Class('text-sm text-zinc-500')], ['Foldkit, Effect, Alchemy and Soroban baseline']),
            ],
          ),
          Button.view(
            {
              onClick: Message.ClickedRefresh(),
              toView: attributes =>
                h.button(
                  [
                    ...attributes.button,
                    h.Class(
                      'min-h-11 rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-700',
                    ),
                  ],
                  ['Refresh'],
                ),
            },
            h,
          ),
        ],
      ),
      healthView(model, h),
      counterView(model, h),
    ],
  ),
})
