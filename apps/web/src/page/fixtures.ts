import { Array } from 'effect'

import type { GrantView, Overview } from '../backend'
import { fixture } from '../backend/fixture'

export const claude: GrantView = Array.getUnsafe(fixture.grants, 0)

export const overview: Overview = {
  wallet: fixture.wallet,
  balances: { usdc: '479000000', xlm: '0' },
  grants: [claude],
  pending: fixture.pending,
  receipts: fixture.receipts,
}

export const revokedClaude: GrantView = {
  ...claude,
  connection_status: 'revoked',
  grant_status: 'revoked',
  rule_status: 'removal_pending',
  remaining: '0',
  revoked_at: '2026-10-25T14:40:00.000Z',
}

export { fixture }
