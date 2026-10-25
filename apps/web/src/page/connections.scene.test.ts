import { Command, click, expect, given, scene, selector, testId } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { ConnectionsData, Message, RevokeConnection, init, update, view } from './connections'
import { claude, fixture, revokedClaude } from './fixtures'

const loaded = modifyFields(init().model, { connections: () => ConnectionsData.Success({ data: fixture.grants }) })

describe('Connections hooks for the rehearsal runner', () => {
  test('revoke, confirm, then the row is marked revoked and the passkey step is linked', () => {
    scene(
      { update, view },
      given(loaded),
      expect(testId('revoke')).toHaveAttr('data-connection', claude.connection_id),
      click(testId('revoke')),
      expect(testId('revoke-confirm')).toHaveAttr('data-connection', claude.connection_id),
      click(testId('revoke-confirm')),
      Command.resolve(
        RevokeConnection,
        Message.SucceededRevokeConnection({ reply: { connection: revokedClaude, approve_url: '/approve/rule_3' } }),
      ),
      expect(selector(`[data-connection="${claude.connection_id}"][data-testid="revoked"]`)).toExist(),
      expect(testId('remove-rule')).toHaveAttr('href', '/approve/rule_3'),
    )
  })
})
