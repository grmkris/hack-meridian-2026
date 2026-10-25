import { Array, Effect, Layer, Option, Ref } from 'effect'

import type { ReceiptRecord } from '@hm/protocol'

import { Backend, BackendFailed, SignedOut } from './backend'
import type { Contact, GrantView, Overview, PendingApproval, WalletSummary } from './views'

/**
 * An in-memory Worker for building and screenshotting the site without the service: the demo of docs/SPEC.md just
 * after step 6 (a 30 USDC wallet; Claude has spent 2.10 of its 5 USDC; a 20 USDC dinner for Bob waits for the nod). Revoking and
 * adding contacts change this state for the life of the page. Addresses are checksum-valid but hold nothing onchain.
 */

const ADDRESS = {
  wallet: 'CBRV22J3LOLAKOPODR6M4IAFN5IV4FCYIP6SDDDXREFF44FLKMVU3PWJ',
  alice: 'CD7SGAMIN5JLN6HOD7ENHNJDQ3C4HICTCPKINJOG2PHUNKQS7QLBYHSW',
  bob: 'GD4EDKUSDEAKUCBB633HS634PMX4NE7L6IFY4WOD45RJVKLUP7XLTOTC',
  carol: 'GDEAHO3TSCX6DIWCXQPCEBN3VC3VVOZGGZ6SFIOFPKLD4BJ7JHXUNMUJ',
  seller: 'GDAOGLNF2RL43GMCP5KRQPOOHGBVAOHOZSL6ANBCT6TVZGTCZMJDE7F6',
  relayer: 'GBFLTGBMKV6CFFMG6ESV6VKWQTEP6LLS22IUTGATBOKL47CSK7WGX4MQ',
} as const

const stroops = (whole: number, hundredths = 0): bigint => BigInt(whole) * 10_000_000n + BigInt(hundredths) * 100_000n
const USDC = (whole: number, hundredths = 0): string => stroops(whole, hundredths).toString()

const wallet: WalletSummary = {
  id: 'wal_personal',
  name: 'Personal',
  contract_id: ADDRESS.wallet,
  network: 'stellar:testnet',
}

const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`

const grants: ReadonlyArray<GrantView> = [
  {
    connection_id: 'con_claude',
    client_name: 'Claude',
    client_domain: 'claude.ai',
    connection_status: 'active',
    grant_id: 'grt_claude',
    total: USDC(5),
    spent: USDC(2, 10),
    reserved: '0',
    pocket_balance: '0',
    remaining: USDC(2, 90),
    rule_id: 3,
    valid_until: '2026-10-26T12:00:00.000Z',
    grant_status: 'active',
    rule_status: 'installed',
    created_at: '2026-10-25T14:02:00.000Z',
    revoked_at: null,
  },
  {
    connection_id: 'con_goblin',
    client_name: 'Goblin',
    client_domain: null,
    connection_status: 'revoked',
    grant_id: 'grt_goblin',
    total: USDC(3),
    spent: USDC(0, 50),
    reserved: '0',
    pocket_balance: '0',
    remaining: '0',
    rule_id: 1,
    valid_until: '2026-10-25T20:00:00.000Z',
    grant_status: 'revoked',
    rule_status: 'removed',
    created_at: '2026-10-25T11:40:00.000Z',
    revoked_at: '2026-10-25T13:15:00.000Z',
  },
]

const pending: ReadonlyArray<PendingApproval> = [
  {
    intent_id: 'int_dinner',
    requester: 'Claude',
    reason: 'Dinner at Taberna, split with Bob',
    recipient_name: 'Bob',
    recipient_address: ADDRESS.bob,
    amount: USDC(20),
    asset: 'USDC',
    expires_at: '2026-10-25T14:52:00.000Z',
    approve_url: '/approve/int_dinner',
  },
]

const receipts: ReadonlyArray<ReceiptRecord> = [
  {
    id: 'rcp_alice',
    operation_id: 'op_alice',
    intent_id: 'int_alice',
    wallet_id: wallet.id,
    connection_id: 'con_claude',
    kind: 'payment',
    amount: stroops(2),
    asset: 'USDC',
    fee_stroops: 15_210_000n,
    fee_paid_by: 'relayer',
    fee_payer: ADDRESS.relayer,
    recipient_name: 'Alice',
    recipient_address: ADDRESS.alice,
    tx_hash: '6f1d3a0c9b2e47f58a1c0d93e6b7a2f4c81d5e09b3a7f6c2d4e8a1b0c9f3d7e2',
    ledger: 1_204_533,
    confirmed_at: '2026-10-25T14:21:05.000Z',
    explorer_url: explorer('6f1d3a0c9b2e47f58a1c0d93e6b7a2f4c81d5e09b3a7f6c2d4e8a1b0c9f3d7e2'),
    pull_tx_hash: null,
    pull_explorer_url: null,
    requester: 'Claude',
    lane: 'autonomous',
    resource: null,
  },
  {
    id: 'rcp_report',
    operation_id: 'op_report',
    intent_id: 'int_report',
    wallet_id: wallet.id,
    connection_id: 'con_claude',
    kind: 'x402_fetch',
    amount: stroops(0, 10),
    asset: 'USDC',
    fee_stroops: 100n,
    fee_paid_by: 'facilitator',
    fee_payer: 'x402.org',
    recipient_name: null,
    recipient_address: ADDRESS.seller,
    tx_hash: 'a92c47e1d05b3f86c1e9047da2b6538f0e7c19d4a6b2f8e3c05d917ab4e6f201',
    ledger: 1_204_388,
    confirmed_at: '2026-10-25T14:09:41.000Z',
    explorer_url: explorer('a92c47e1d05b3f86c1e9047da2b6538f0e7c19d4a6b2f8e3c05d917ab4e6f201'),
    pull_tx_hash: '3c8e0b5a71f4d2e96b0a8c3f1d7e5b2a94c6d0e8f3b1a7c5d9e2f4a6b8c0d1e3',
    pull_explorer_url: explorer('3c8e0b5a71f4d2e96b0a8c3f1d7e5b2a94c6d0e8f3b1a7c5d9e2f4a6b8c0d1e3'),
    requester: 'Claude',
    lane: 'autonomous',
    resource: 'https://hm-seller.workers.dev/report',
  },
]

const contacts: ReadonlyArray<Contact> = [
  {
    id: 'ctc_alice',
    owner_id: 'own_fixture',
    display_name: 'Alice',
    aliases: [],
    destinations: [
      {
        address: ADDRESS.alice,
        network: 'stellar:testnet',
        memo: null,
        readiness: 'usdc_ready',
        verified_at: '2026-10-25T13:30:00.000Z',
        last_paid_at: '2026-10-25T14:21:05.000Z',
      },
    ],
    created_at: '2026-10-25T13:30:00.000Z',
  },
  {
    id: 'ctc_bob',
    owner_id: 'own_fixture',
    display_name: 'Bob',
    aliases: ['Bobby'],
    destinations: [
      {
        address: ADDRESS.bob,
        network: 'stellar:testnet',
        memo: null,
        readiness: 'usdc_ready',
        verified_at: '2026-10-25T13:31:00.000Z',
        last_paid_at: null,
      },
    ],
    created_at: '2026-10-25T13:31:00.000Z',
  },
  {
    id: 'ctc_carol',
    owner_id: 'own_fixture',
    display_name: 'Carol',
    aliases: [],
    destinations: [
      {
        address: ADDRESS.carol,
        network: 'stellar:testnet',
        memo: null,
        readiness: 'trustline_required',
        verified_at: '2026-10-25T13:32:00.000Z',
        last_paid_at: null,
      },
    ],
    created_at: '2026-10-25T13:32:00.000Z',
  },
]

interface State {
  readonly signedIn: boolean
  readonly grants: ReadonlyArray<GrantView>
  readonly contacts: ReadonlyArray<Contact>
}

const FIXTURE_TIME = '2026-10-25T14:30:00.000Z'

/** The fixture Worker. `signedIn: false` starts on the passkey welcome page. */
export const fixtureBackend = (options: { readonly signedIn: boolean }) =>
  Layer.effect(
    Backend,
    Effect.gen(function* () {
      const state = yield* Ref.make<State>({ signedIn: options.signedIn, grants, contacts })
      const whenSignedIn = <A>(read: (current: State) => A) =>
        Effect.flatMap(Ref.get(state), current =>
          current.signedIn ? Effect.succeed(read(current)) : Effect.fail(new SignedOut()),
        )
      const signIn = Effect.as(
        Ref.update(state, current => ({ ...current, signedIn: true })),
        wallet,
      )
      const overview = whenSignedIn((current): Overview => ({
        wallet,
        balances: { usdc: USDC(27, 90), xlm: '0' },
        network: 'stellar:testnet',
        explorer_base: 'https://stellar.expert/explorer/testnet',
        grants: Array.filter(current.grants, grant => grant.connection_status === 'active'),
        pending,
        receipts,
      }))
      return {
        session: whenSignedIn(() => wallet),
        registrationOptions: (name, _maybeInviteCode) =>
          Effect.succeed({
            challenge: 'Zml4dHVyZS1yZWdpc3RyYXRpb24',
            rp_id: 'localhost',
            rp_name: 'Nod',
            user_id: 'b3duX2ZpeHR1cmU',
            user_name: name,
          }),
        createWallet: registration =>
          Effect.as(signIn, { ...wallet, name: registration.name === '' ? wallet.name : registration.name }),
        assertionOptions: Effect.succeed({
          challenge: 'Zml4dHVyZS1hc3NlcnRpb24',
          rp_id: 'localhost',
          allow_credentials: ['Zml4dHVyZS1jcmVkZW50aWFs'],
        }),
        signIn: () => signIn,
        signOut: Ref.update(state, current => ({ ...current, signedIn: false })),
        overview,
        connections: whenSignedIn(current => current.grants),
        revokeConnection: connectionId =>
          Effect.flatMap(
            whenSignedIn(current => current),
            current =>
              Option.match(
                Array.findFirst(current.grants, grant => grant.connection_id === connectionId),
                {
                  onNone: () => Effect.fail(new BackendFailed({ error: 'That connection no longer exists.' })),
                  onSome: grant => {
                    const revoked: GrantView = {
                      ...grant,
                      connection_status: 'revoked',
                      grant_status: 'revoked',
                      rule_status: 'removal_pending',
                      remaining: '0',
                      revoked_at: FIXTURE_TIME,
                    }
                    return Effect.as(
                      Ref.update(state, latest => ({
                        ...latest,
                        grants: Array.map(latest.grants, each =>
                          each.connection_id === connectionId ? revoked : each,
                        ),
                      })),
                      { connection: revoked, approve_url: null },
                    )
                  },
                },
              ),
          ),
        contacts: whenSignedIn(current => current.contacts),
        addContact: input =>
          Effect.flatMap(
            whenSignedIn(current => current),
            current => {
              const contact: Contact = {
                id: `ctc_${current.contacts.length + 1}`,
                owner_id: 'own_fixture',
                display_name: input.display_name,
                aliases: input.aliases ?? [],
                destinations: [
                  {
                    address: input.address,
                    network: 'stellar:testnet',
                    memo: input.memo ?? null,
                    readiness: input.address.startsWith('C') ? 'usdc_ready' : 'unverified',
                    verified_at: null,
                    last_paid_at: null,
                  },
                ],
                created_at: FIXTURE_TIME,
              }
              return Effect.as(
                Ref.update(state, latest => ({ ...latest, contacts: [...latest.contacts, contact] })),
                contact,
              )
            },
          ),
        receipts: whenSignedIn(() => receipts),
      }
    }),
  )

/** The fixture data, for tests and stories. */
export const fixture = { wallet, grants, pending, receipts, contacts, address: ADDRESS } as const
