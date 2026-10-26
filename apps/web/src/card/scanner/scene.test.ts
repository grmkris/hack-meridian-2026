import { Command, Mount, click, expect, given, role, scene, selector } from 'foldkit/scene'
import { describe, test } from 'vitest'

import type { RecipientReadOutput } from '@hm/protocol'

import { CaptureQr, ShareRecipient, init, update, view } from './main'
import { OpenCamera } from './media'
import { Message } from './message'

const recipient: RecipientReadOutput = {
  kind: 'recipient',
  address: 'GD4EDKUSDEAKUCBB633HS634PMX4NE7L6IFY4WOD45RJVKLUP7XLTOTC',
  address_kind: 'account',
  network: 'stellar:testnet',
  grant_remaining: '5.00',
}

describe('recipient scanner review', () => {
  test('stops the camera for review and preserves the address when the host rejects sharing', () => {
    const connected = update(init().model, Message.Connected({ capabilities: { serverTools: {} }, context: {} })).model
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Open camera' })),
      Mount.resolve(OpenCamera, Message.SucceededCamera({ attempt: 1 })),
      click(role('button', { name: 'Capture QR code' })),
      Command.resolve(CaptureQr, Message.SucceededRead({ attempt: 1, recipient })),
      Mount.expectEnded(OpenCamera),
      expect(selector('.nod-address')).toHaveText(recipient.address),
      expect(role('button', { name: 'Use this recipient' })).toExist(),
      click(role('button', { name: 'Use this recipient' })),
      Command.resolve(ShareRecipient, Message.FailedShare({ attempt: 1, reason: 'Messages are blocked.' })),
      expect(selector('.nod-address')).toHaveText(recipient.address),
      expect(role('button', { name: 'Copy address' })).toExist(),
      expect(role('status')).toHaveText('Messages are blocked. Copy the address into the chat instead.'),
    )
  })
})
