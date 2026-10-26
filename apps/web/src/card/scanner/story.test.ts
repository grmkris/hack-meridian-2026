import { describe, expect, test } from 'vitest'

import type { RecipientReadOutput } from '@hm/protocol'

import { init, update } from './main'
import { Message } from './message'

const recipient: RecipientReadOutput = {
  kind: 'recipient',
  address: 'GD4EDKUSDEAKUCBB633HS634PMX4NE7L6IFY4WOD45RJVKLUP7XLTOTC',
  address_kind: 'account',
  network: 'stellar:testnet',
  grant_remaining: '5.00',
}
const connected = () =>
  update(init().model, Message.Connected({ capabilities: { serverTools: {} }, context: {} })).model

describe('recipient scanner state transitions', () => {
  test('requires a camera or file read to produce a reviewable recipient', () => {
    const model = connected()
    expect(model.phase._tag).toBe('Idle')
    const opened = update(model, Message.ClickedCamera()).model
    expect(opened.phase).toEqual({ _tag: 'Camera', ready: false })
    const ready = update(opened, Message.SucceededCamera({ attempt: 1 })).model
    expect(ready.phase).toEqual({ _tag: 'Camera', ready: true })
    const reviewed = update(ready, Message.SucceededRead({ attempt: 1, recipient })).model
    expect(reviewed.phase).toEqual({ _tag: 'Review', recipient })
  })
  test('a cancelled attempt cannot revive a recipient from a previous camera frame', () => {
    const opened = update(connected(), Message.ClickedCamera()).model
    const cancelled = update(opened, Message.ClickedReset()).model
    const late = update(cancelled, Message.SucceededRead({ attempt: 1, recipient })).model
    expect(late.phase).toEqual({ _tag: 'Idle' })
  })
})
