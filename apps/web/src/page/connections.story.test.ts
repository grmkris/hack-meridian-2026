import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { Problem } from '../problem'
import { ConnectionsData, Message, Revoke, RevokeConnection, init, update } from './connections'
import { claude, fixture, revokedClaude } from './fixtures'

const loaded = modifyFields(init().model, { connections: () => ConnectionsData.Success({ data: fixture.grants }) })

describe('Connections', () => {
  test('revoking asks first, and cancelling leaves the connection alone', () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedRevoke({ connectionId: claude.connection_id })),
      Command.expectNone(),
      model(nextModel => {
        expect(nextModel.revoke).toEqual(Revoke.Confirming({ connectionId: claude.connection_id }))
      }),
      message(Message.ClickedCancelRevoke()),
      model(nextModel => {
        expect(nextModel.revoke).toEqual(Revoke.Idle())
      }),
    )
  })

  test('a confirmed revoke replaces the connection and offers the passkey step for the onchain rule', () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedRevoke({ connectionId: claude.connection_id })),
      message(Message.ClickedConfirmRevoke({ connectionId: claude.connection_id })),
      Command.expectExact(RevokeConnection({ connectionId: claude.connection_id })),
      Command.resolve(
        RevokeConnection,
        Message.SucceededRevokeConnection({ reply: { connection: revokedClaude, approve_url: '/approve/rule_3' } }),
      ),
      model(nextModel => {
        expect(nextModel.revoke).toEqual(Revoke.Idle())
        expect(nextModel.maybeRuleRemovalUrl).toEqual(Option.some('/approve/rule_3'))
        expect(nextModel.connections).toEqual({
          _tag: 'Success',
          data: [revokedClaude, ...fixture.grants.slice(1)],
        })
      }),
    )
  })

  test('a failed revoke keeps the list and shows the reason on that connection', () => {
    story(
      update,
      given(loaded),
      message(
        Message.FailedRevokeConnection({
          connectionId: claude.connection_id,
          problem: Problem.Failed({ error: 'The relayer is out of XLM.' }),
        }),
      ),
      model(nextModel => {
        expect(nextModel.revoke).toEqual(
          Revoke.Failed({ connectionId: claude.connection_id, error: 'The relayer is out of XLM.' }),
        )
        expect(nextModel.connections).toEqual(loaded.connections)
      }),
    )
  })
})
