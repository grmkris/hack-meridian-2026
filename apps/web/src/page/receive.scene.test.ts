import { Option } from 'effect'
import {
  Command,
  Subscription,
  change,
  click,
  expect,
  given,
  role,
  scene,
  testId,
  text,
  withViewInputs,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { fixture, overview } from './fixtures'
import {
  CopyAddress,
  AddressCopy,
  DepositData,
  LoadDeposit,
  Message,
  Topup,
  TopupAssetsData,
  init,
  update,
  view as receiveView,
} from './receive'

const view = withViewInputs(receiveView, { overview, nowMs: Option.some(1792929600000), backHref: '/' })()
const deposit = {
  address: fixture.address.deposit,
  recipient: fixture.address.wallet,
  expires_ledger: 8496182,
  expires_at: '2027-04-23T18:30:00Z',
  pending: '50000000',
  swept_total: '10000000',
  create_tx: 'a'.repeat(64),
  register_tx: 'b'.repeat(64),
  lock_tx: 'c'.repeat(64),
  last_sweep_tx: null,
}

describe('Receive', () => {
  test('the exchange action replaces the wallet address, with a recoverable clipboard failure', () => {
    scene(
      { update, view },
      given(init().model),
      expect(testId('wallet-address')).toExist(),
      expect(testId('address-qr')).toExist(),
      expect(testId('deposit-address')).not.toExist(),
      click(role('button', { name: 'Sending from an exchange?' })),
      expect(testId('wallet-address')).not.toExist(),
      Command.resolve(LoadDeposit, Message.SucceededLoadDeposit({ deposit })),
      expect(testId('deposit-address')).toExist(),
      expect(testId('deposit-qr')).toExist(),
      expect(text('5.00 USDC')).toExist(),
      click(role('button', { name: 'Copy address' })),
      Command.expectExact(CopyAddress({ address: fixture.address.deposit })),
      Command.resolve(CopyAddress, Message.FailedCopyAddress({ address: fixture.address.deposit })),
      expect(text('Clipboard unavailable. Select the address above and copy it.')).toExist(),
      click(role('button', { name: 'Use my wallet address' })),
      expect(testId('wallet-address')).toExist(),
      expect(testId('deposit-address')).not.toExist(),
    )
  })

  test('an awaiting-deposit wallet never offers its undeployed C-address as a destination', () => {
    const awaitingView = withViewInputs(receiveView, {
      overview: { ...overview, wallet: { ...overview.wallet, account_status: 'awaiting_deposit' } },
      nowMs: Option.none(),
      backHref: '/',
    })()
    scene(
      { update, view: awaitingView },
      given(modifyFields(init().model, { deposit: () => DepositData.Success({ data: deposit }) })),
      expect(testId('wallet-address')).not.toExist(),
      expect(testId('deposit-address')).toExist(),
      expect(role('button', { name: 'Use my wallet address' })).not.toExist(),
    )
  })

  test('copy completion for an old destination cannot say the new address was copied', () => {
    scene(
      { update, view },
      given(
        modifyFields(init().model, {
          addressCopy: () => AddressCopy.Copying({ address: overview.wallet.contract_id }),
        }),
      ),
      click(role('button', { name: 'Sending from an exchange?' })),
      Command.resolve(LoadDeposit, Message.SucceededLoadDeposit({ deposit })),
      Subscription.emit(Message.CompletedCopyAddress({ address: overview.wallet.contract_id })),
      expect(role('button', { name: 'Copied' })).not.toExist(),
      expect(role('button', { name: 'Copy address' })).toExist(),
    )
  })

  test('a pending quote stays available when switching to Stellar and back', () => {
    const quote = {
      id: 'tq_1',
      pay_to: '0x1234567890123456789012345678901234567890',
      amount_in: '5',
      amount_out: '4.98',
      origin_chain: 'base',
      asset: 'USDC',
      deadline: '2026-10-25T22:35:00Z',
      status: 'pending' as const,
      sweep_tx: null,
    }
    const quotedView = withViewInputs(receiveView, {
      overview: { ...overview, network: 'stellar:pubnet' },
      nowMs: Option.some(1792929600000),
      backHref: '/connections',
    })()
    const quoted = modifyFields(init().model, {
      network: () => 'base',
      topup: () => Topup.Quoted({ quote }),
      topupForm: () => ({ chain: 'base', assetId: 'usdc', amount: '5', refundTo: '0xrefund' }),
      topupAssets: () =>
        TopupAssetsData.Success({ data: [{ chain: 'base', assets: [{ id: 'usdc', symbol: 'USDC', decimals: 6 }] }] }),
    })
    scene(
      { update, view: quotedView },
      given(quoted),
      expect(testId('topup-address')).toExist(),
      change(role('combobox', { name: 'From network' }), 'stellar'),
      expect(testId('wallet-address')).toExist(),
      expect(testId('topup-address')).not.toExist(),
      click(role('button', { name: 'View transfer' })),
      expect(testId('topup-address')).toExist(),
      expect(role('link', { name: 'Back' })).toHaveAttr('href', '/connections'),
      Command.expectNone(),
    )
  })
})
