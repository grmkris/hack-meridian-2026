import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { Problem } from '../problem'
import { overview } from './fixtures'
import { DepositData, LoadDeposit, Message, init, update } from './home'

/** Add money's deposit address (B, deposit-first): loaded when the wallet waits for USDC or has one; else on request. */
const deposit = {
  address: 'GB7EGCF2J4WRZM74ZSMCLYIB2A3M5Z4NO2EGRSYTCXIIXBO4IYMSZ4VQ',
  recipient: overview.wallet.contract_id,
  expires_ledger: 8_496_182,
  expires_at: '2027-04-23T18:30:00.000Z',
  pending: '0',
  swept_total: '27500000',
  create_tx: 'ad82b35901c6c5dee76ac430edc32d19b6b7e1de3be01c2cca1c2c9ff2ea4473',
  register_tx: '3c2d253df23b2167716655fb87a3776bed00e4038b10b95684e2af3e49eeccaa',
  lock_tx: '0998d2f98263af425dd0338c0f1987a0154e95a8942843fb9d8e81fa48f4f36f',
  last_sweep_tx: null,
}

describe('Home: the deposit address', () => {
  test('a wallet waiting for its first USDC loads its deposit address with the overview', () => {
    const waiting = { ...overview, wallet: { ...overview.wallet, account_status: 'awaiting_deposit' as const } }
    story(
      update,
      given(init().model),
      message(Message.SucceededLoadOverview({ overview: waiting })),
      Command.expectExact(LoadDeposit),
      Command.resolve(LoadDeposit, Message.SucceededLoadDeposit({ deposit })),
      model(nextModel => {
        expect(nextModel.deposit).toEqual(DepositData.Success({ data: deposit }))
      }),
    )
  })

  test('a deployed wallet without one loads nothing until the owner asks; a failure shows its sentence', () => {
    story(
      update,
      given(init().model),
      message(Message.SucceededLoadOverview({ overview })),
      Command.expectNone(),
      message(Message.ClickedGetDepositAddress()),
      Command.expectExact(LoadDeposit),
      Command.resolve(
        LoadDeposit,
        Message.FailedLoadDeposit({ problem: Problem.Failed({ error: 'deposit_unavailable: no router' }) }),
      ),
      model(nextModel => {
        expect(nextModel.deposit).toEqual(DepositData.Failure({ error: 'deposit_unavailable: no router' }))
      }),
    )
  })

  test('a second click while it is being created starts no second request', () => {
    story(
      update,
      given(modifyFields(init().model, { deposit: () => DepositData.Loading() })),
      message(Message.ClickedGetDepositAddress()),
      Command.expectNone(),
    )
  })
})
