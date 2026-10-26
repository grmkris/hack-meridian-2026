import { Option } from 'effect'
import { Command, click, expect, given, role, scene, Subscription, testId, text, withViewInputs } from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import type { Overview } from '../backend'
import { claude, overview, revokedClaude } from './fixtures'
import { CopySetup, LoadOverview, Message, OverviewData, init, update, view as homeView } from './home'

const view = withViewInputs(homeView, { connectorUrl: 'https://wallet.test/mcp' })()
const nowMs = 1792929600000
const loaded = (data: Overview) =>
  modifyFields(init().model, {
    overview: () => OverviewData.Success({ data }),
    maybeNowMs: () => Option.some(nowMs),
  })
const empty: Overview = { ...overview, balances: { usdc: '0', xlm: '0' }, grants: [], pending: [], receipts: [] }

describe('Home connection and funding tasks', () => {
  test('a new wallet has both setup artifacts with no app picker', () => {
    scene(
      { update, view },
      given(loaded(empty)),
      expect(role('button', { name: 'Copy setup prompt' })).toExist(),
      expect(role('button', { name: 'Copy MCP URL' })).toExist(),
      expect(
        text('Read https://wallet.test/skill/nod-guide/setup.md and follow its instructions to connect Nod.'),
      ).toExist(),
      expect(role('button', { name: 'ChatGPT' })).not.toExist(),
      expect(role('button', { name: 'Connect another app' })).not.toExist(),
      click(role('button', { name: 'Copy setup prompt' })),
      Command.expectExact(CopySetup({ target: 'Prompt', connectorUrl: 'https://wallet.test/mcp' })),
      Command.resolve(CopySetup, Message.CompletedCopySetup({ target: 'Prompt' })),
      expect(text('Setup prompt copied.')).toExist(),
      click(role('button', { name: 'Copy MCP URL' })),
      Command.resolve(CopySetup, Message.FailedCopySetup({ target: 'Url' })),
      expect(text('Clipboard unavailable. Select the text above and copy it.')).toExist(),
      expect(text('https://wallet.test/mcp')).toExist(),
    )
  })

  test('connected wallets keep setup under a disclosure beside pending approvals', () => {
    scene(
      { update, view },
      given(loaded(overview)),
      expect(role('button', { name: 'Copy MCP URL' })).not.toExist(),
      expect(role('link', { name: 'Open Claude' })).toHaveAttr('href', 'https://claude.ai/'),
      click(role('button', { name: 'Connect another app' })),
      expect(role('button', { name: 'Copy MCP URL' })).toExist(),
      expect(role('link', { name: 'Review and approve' })).toHaveAttr('href', '/approve/int_dinner'),
    )
  })

  test('multiple apps keep independent allowances; expired or revoked permission is never shown as spendable', () => {
    const data: Overview = {
      ...overview,
      grants: [
        claude,
        {
          ...claude,
          connection_id: 'expired',
          client_name: 'Old app',
          valid_until: '2026-10-01T00:00:00Z',
          remaining: '11000000',
          client_domain: 'javascript:alert(1)',
        },
        { ...revokedClaude, connection_id: 'revoked', client_name: 'Revoked app' },
        { ...claude, connection_id: 'no-domain', client_name: 'Local app', client_domain: null, remaining: '17000000' },
      ],
    }
    scene(
      { update, view },
      given(loaded(data)),
      expect(text('2.90 USDC')).toExist(),
      expect(text('1.70 USDC')).toExist(),
      expect(text('1.10 USDC')).not.toExist(),
      expect(text('Allowance expired. Ask your app for a new one.')).toExist(),
      expect(text('Revoked app')).not.toExist(),
      expect(role('link', { name: 'Open Old app' })).not.toExist(),
      expect(role('link', { name: 'Open Local app' })).not.toExist(),
      expect(text('Return to Local app to use Nod.')).toExist(),
    )
  })

  test('the clock expires an allowance at its boundary without waiting for a server refresh', () => {
    scene(
      { update, view },
      given(
        modifyFields(loaded({ ...overview, grants: [{ ...claude, valid_until: '2026-10-25T12:00:00Z' }] }), {
          maybeNowMs: () => Option.some(Date.parse('2026-10-25T11:59:59Z')),
        }),
      ),
      expect(text('2.90 USDC')).toExist(),
      Subscription.emit(Message.TickedTopupClock({ nowMs: Date.parse('2026-10-25T12:00:00Z') })),
      expect(text('2.90 USDC')).not.toExist(),
      expect(text('Allowance expired. Ask your app for a new one.')).toExist(),
    )
  })

  test('an unavailable overview offers retry and never invents a zero balance', () => {
    scene(
      { update, view },
      given(modifyFields(init().model, { overview: () => OverviewData.Failure({ error: 'RPC unavailable.' }) })),
      expect(role('alert')).toExist(),
      expect(testId('wallet-balance')).not.toExist(),
      click(role('button', { name: 'Try again' })),
      Command.resolve(LoadOverview, Message.SucceededLoadOverview({ overview: empty, nowMs })),
    )
  })
})
