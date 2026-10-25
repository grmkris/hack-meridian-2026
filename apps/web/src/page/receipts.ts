import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, Submodel, type Update } from 'foldkit'
import type { Html } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Backend, ReceiptRecord, type Resources } from '../backend'
import { Problem, recoverProblem } from '../problem'
import { receiptRow } from '../view/receipt'
import { emptyRow, errorRow, loadingRow, pageHeader, panel } from '../view/ui'

// MODEL

export const ReceiptsData = AsyncData.Schema(Schema.Array(ReceiptRecord), Schema.String)

export const Model = Schema.Struct({ receipts: ReceiptsData.schema })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  EnteredPage: {},
  SucceededLoadReceipts: { receipts: Schema.Array(ReceiptRecord) },
  FailedLoadReceipts: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ EndedSession: {} })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Update.Return<Model, Message, Resources> => ({ model: { receipts: ReceiptsData.Idle() } })

// COMMAND

export const LoadReceipts = Command.define('LoadReceipts', {
  messages: [Message.SucceededLoadReceipts, Message.FailedLoadReceipts],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const receipts = yield* backend.receipts
    return Message.SucceededLoadReceipts({ receipts })
  }).pipe(recoverProblem(problem => Message.FailedLoadReceipts({ problem }))),
})

// UPDATE

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () =>
      Option.match(AsyncData.revalidateOrLoad(model.receipts), {
        onNone: () => ({ model }),
        onSome: nextReceipts => ({
          model: modifyFields(model, { receipts: () => nextReceipts }),
          commands: [LoadReceipts()],
        }),
      }),
    SucceededLoadReceipts: ({ receipts }) => ({
      model: modifyFields(model, { receipts: () => ReceiptsData.Success({ data: receipts }) }),
    }),
    FailedLoadReceipts: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => ({
          model: modifyFields(model, { receipts: () => ReceiptsData.Idle() }),
          outMessage: OutMessage.EndedSession(),
        }),
        Failed: ({ error }) => ({ model: modifyFields(model, { receipts: () => ReceiptsData.Failure({ error }) }) }),
      }),
  })

export const informEntered = (model: Model) => update(model, Message.EnteredPage())

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      pageHeader(
        'Receipts',
        'Every confirmed payment, with who asked, which lane paid it and the transactions on the explorer. A receipt appears only after the network confirms the payment.',
        h,
      ),
      panel(
        'Confirmed payments',
        [
          AsyncData.matchData(model.receipts, {
            onEmpty: () => loadingRow(h),
            onFailure: error => errorRow(error, h),
            onData: receipts =>
              Array.match(receipts, {
                onEmpty: () => emptyRow('No payments yet.', h),
                onNonEmpty: list =>
                  h.ul(
                    [h.Class('divide-y divide-line')],
                    Array.map(list, receipt => receiptRow(receipt, h)),
                  ),
              }),
          }),
        ],
        h,
      ),
    ],
  ),
)
