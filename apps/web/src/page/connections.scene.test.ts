import { Command, click, expect, given, scene, selector, testId, withViewInputs } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import {
  ConnectionsData,
  LinksData,
  Message,
  RevokeConnection,
  init,
  update,
  view as connectionsView,
} from './connections'

const view = withViewInputs(connectionsView, { network: 'stellar:testnet' })()
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

  test('person links: one row each, Revoke only while a link is open, the paid one links its transaction', () => {
    const open = {
      id: 'cl_open',
      recipient_name: 'Jan',
      amount: '50000000',
      status: 'open' as const,
      expires_at: '2026-11-01T20:00:00.000Z',
      revoke_url: '/approve/revoke-link/cl_open',
    }
    const paid = {
      id: 'cl_paid',
      recipient_name: 'Mia',
      amount: '10000000',
      status: 'paid' as const,
      expires_at: '2026-11-01T18:00:00.000Z',
      revoke_url: null,
      paid_at: '2026-10-25T20:09:08.000Z',
      tx_hash: 'eb9def8cebc58e8ad0f659e70123ab12449cc91184a243172825bd1f25dd4f1e',
    }
    scene(
      { update, view },
      given(modifyFields(loaded, { links: () => LinksData.Success({ data: [open, paid] }) })),
      expect(selector('[data-testid="link-row"][data-link="cl_open"]')).toExist(),
      expect(selector('[data-testid="link-row"][data-link="cl_paid"]')).toExist(),
      expect(testId('link-revoke')).toHaveAttr('href', '/approve/revoke-link/cl_open'),
      expect(
        selector(
          '[data-link="cl_paid"] a[href="https://stellar.expert/explorer/testnet/tx/eb9def8cebc58e8ad0f659e70123ab12449cc91184a243172825bd1f25dd4f1e"]',
        ),
      ).toExist(),
    )
  })
})
