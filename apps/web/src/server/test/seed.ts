import { Effect } from 'effect'

import { insert, write } from '../rows.ts'

export const WALLET_ID = 'wal_test'
export const OWNER_ID = 'own_test'
export const CONTRACT_ID = 'CWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB'
export const BOB = 'GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
export const ALICE = 'CALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
export const SIGNER = 'GSIGNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB'

/** An owner with one wallet, one connection and its grant (5 USDC, valid for a day from the seed time). */
export const seedWallet = (
  options: {
    readonly total?: bigint
    readonly connectionId?: string
    readonly grantId?: string
    readonly ruleId?: number
  } = {},
) =>
  write(
    insert('owners', { id: OWNER_ID, created_at: '2026-10-25T12:00:00.000Z' }),
    insert('wallets', {
      id: WALLET_ID,
      owner_id: OWNER_ID,
      name: 'Personal',
      contract_id: CONTRACT_ID,
      passkey_credential_id: 'cred',
      passkey_public_key: 'pub',
      network: 'stellar:testnet',
      deploy_tx: null,
      fund_tx: null,
      created_at: '2026-10-25T12:00:00.000Z',
    }),
  ).pipe(Effect.andThen(seedConnection(options)))

export const seedConnection = (
  options: {
    readonly total?: bigint
    readonly connectionId?: string
    readonly grantId?: string
    readonly ruleId?: number
  } = {},
) => {
  const connectionId = options.connectionId ?? 'con_a'
  const grantId = options.grantId ?? 'gr_a'
  return write(
    insert('connections', {
      id: connectionId,
      owner_id: OWNER_ID,
      wallet_id: WALLET_ID,
      oauth_client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
      oauth_client_name: 'Claude Code',
      oauth_client_domain: 'claude.ai',
      oauth_grant_id: `oauth_${connectionId}`,
      status: 'active',
      created_at: '2026-10-25T12:00:00.000Z',
      revoked_at: null,
    }),
    insert('spending_grants', {
      id: grantId,
      connection_id: connectionId,
      wallet_id: WALLET_ID,
      signer_public_key: SIGNER,
      signer_key_ref: `fixture:${SIGNER}`,
      asset: 'USDC',
      total: options.total ?? 50_000_000n,
      spent: 0n,
      reserved: 0n,
      valid_until: '2099-01-01T00:00:00.000Z',
      valid_until_ledger: 9_999_999,
      rule_id: options.ruleId ?? 1,
      rule_status: 'installed',
      pocket_address: SIGNER,
      pocket_balance: 0n,
      first_payment_done: false,
      status: 'active',
      install_tx: 'tx-install',
      created_at: '2026-10-25T12:00:00.000Z',
    }),
  )
}
