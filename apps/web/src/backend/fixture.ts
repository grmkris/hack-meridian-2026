import { Array, DateTime, Effect, Layer, Option, Ref } from 'effect'

import type { ReceiptRecord } from '@hm/protocol'

import { Backend, BackendFailed, SignedOut } from './backend'
import type { Contact, GrantView, Overview, PendingApproval, TopupChain, TopupQuoteView, WalletSummary } from './views'

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
  deposit: 'GB7EGCF2J4WRZM74ZSMCLYIB2A3M5Z4NO2EGRSYTCXIIXBO4IYMSZ4VQ',
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
  /** The last top-up quote and how often its status was read (each read moves it one step: pending → processing → arrived). */
  readonly topup: Option.Option<Readonly<{ quote: TopupQuoteView; reads: number }>>
}

/** NEAR Intents origin assets (1Click ids from docs/NEAR-INTENTS.md where verified), stablecoins and natives. */
const TOPUP_CHAINS: ReadonlyArray<TopupChain> = [
  {
    chain: 'base',
    assets: [
      { id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', symbol: 'USDC', decimals: 6 },
      { id: 'nep141:base.omft.near', symbol: 'ETH', decimals: 18 },
    ],
  },
  {
    chain: 'sol',
    assets: [
      { id: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', symbol: 'USDC', decimals: 6 },
      { id: 'nep141:sol.omft.near', symbol: 'SOL', decimals: 9 },
    ],
  },
  {
    chain: 'eth',
    assets: [
      { id: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', symbol: 'USDC', decimals: 6 },
      { id: 'nep141:eth.omft.near', symbol: 'ETH', decimals: 18 },
    ],
  },
  {
    chain: 'arb',
    assets: [{ id: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', symbol: 'USDC', decimals: 6 }],
  },
  {
    chain: 'pol',
    assets: [{ id: 'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omft.near', symbol: 'USDC', decimals: 6 }],
  },
]

/** What one unit of the origin asset buys in USDC, for the fixture's estimates only. */
const FIXTURE_RATE: Readonly<Record<string, number>> = { USDC: 0.9964, ETH: 2_512.4, SOL: 176.3 }

const FIXTURE_PAY_TO: Readonly<Record<string, string>> = {
  base: '0x5b1e2f0c9d4a7e6b3c8f1a2d4e6b8c0a1f3e5d7c',
  eth: '0x5b1e2f0c9d4a7e6b3c8f1a2d4e6b8c0a1f3e5d7c',
  arb: '0x5b1e2f0c9d4a7e6b3c8f1a2d4e6b8c0a1f3e5d7c',
  pol: '0x5b1e2f0c9d4a7e6b3c8f1a2d4e6b8c0a1f3e5d7c',
  sol: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
}

const nextTopupStep = (quote: TopupQuoteView, reads: number): TopupQuoteView =>
  reads <= 1
    ? quote
    : reads === 2
      ? { ...quote, status: 'processing' }
      : { ...quote, status: 'arrived', sweep_tx: 'edc8f3b2c15e0c9d3a7b1f4e2d6c8a0b9e7f5d3c1a2b4e6d8f0a9c7e5b3d1f2a' }

const FIXTURE_TIME = '2026-10-25T14:30:00.000Z'

/** The fixture Worker. `signedIn: false` starts on the passkey welcome page. */
export const fixtureBackend = (options: {
  readonly signedIn: boolean
  /** `unavailable`: every top-up answers `topup_unavailable`, as on a network without a deposit router. */
  readonly topup?: 'available' | 'unavailable'
}) =>
  Layer.effect(
    Backend,
    Effect.gen(function* () {
      const state = yield* Ref.make<State>({ signedIn: options.signedIn, grants, contacts, topup: Option.none() })
      const topupUnavailable = Effect.fail(new BackendFailed({ error: 'topup_unavailable' }))
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
        deposits_available: true,
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
        links: whenSignedIn(() => [
          {
            id: 'cl_5e4de4aa5e4de4aa5e4de4aa5e4de4aa',
            recipient_name: 'Jan',
            amount: USDC(5),
            status: 'open' as const,
            expires_at: '2026-11-01T20:00:00.000Z',
            revoke_url: '/approve/revoke-link/cl_5e4de4aa5e4de4aa5e4de4aa5e4de4aa',
            paid_at: null,
            tx_hash: null,
            install_tx: '34195e4253b74612681ee2b577038f9e263dfd7838c29b332139c9186997127e',
          },
          {
            id: 'cl_0204dcd551d21c235b54d30aaaa692c9',
            recipient_name: 'Mia',
            amount: USDC(1),
            status: 'paid' as const,
            expires_at: '2026-11-01T18:00:00.000Z',
            revoke_url: null,
            paid_at: '2026-10-25T20:09:08.000Z',
            tx_hash: 'eb9def8cebc58e8ad0f659e70123ab12449cc91184a243172825bd1f25dd4f1e',
            install_tx: '3ff0e2e018ebffb17b5cf9c98b9b16d2abca4f6077ecfa57d78a4c08f95f42d2',
          },
        ]),
        topupAssets: options.topup === 'unavailable' ? topupUnavailable : whenSignedIn(() => TOPUP_CHAINS),
        topupQuote: request =>
          options.topup === 'unavailable'
            ? topupUnavailable
            : Effect.gen(function* () {
                yield* whenSignedIn(() => undefined)
                const chain = Array.findFirst(TOPUP_CHAINS, each =>
                  Array.some(each.assets, asset => asset.id === request.origin_asset),
                )
                const asset = Option.flatMap(chain, each =>
                  Array.findFirst(each.assets, candidate => candidate.id === request.origin_asset),
                )
                if (Option.isNone(chain) || Option.isNone(asset))
                  return yield* new BackendFailed({ error: 'That asset cannot top up a Nod wallet.' })
                const amount = Number(request.amount)
                if (!(amount > 0)) return yield* new BackendFailed({ error: 'Enter an amount above 0.' })
                const now = yield* DateTime.now
                const quote: TopupQuoteView = {
                  id: 'tq_fixture',
                  pay_to: FIXTURE_PAY_TO[chain.value.chain] ?? FIXTURE_PAY_TO['base'] ?? '',
                  amount_in: request.amount,
                  amount_out: (amount * (FIXTURE_RATE[asset.value.symbol] ?? 1)).toFixed(2),
                  origin_chain: chain.value.chain,
                  asset: asset.value.symbol,
                  deadline: DateTime.formatIso(DateTime.add(now, { minutes: 30 })),
                  status: 'pending',
                  sweep_tx: null,
                }
                yield* Ref.update(state, current => ({ ...current, topup: Option.some({ quote, reads: 0 }) }))
                return quote
              }),
        topupStatus: id =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            if (Option.isNone(current.topup) || current.topup.value.quote.id !== id)
              return yield* new BackendFailed({ error: 'No such top-up.' })
            const reads = current.topup.value.reads + 1
            yield* Ref.set(state, { ...current, topup: Option.some({ quote: current.topup.value.quote, reads }) })
            return nextTopupStep(current.topup.value.quote, reads)
          }),
        depositAddress: whenSignedIn(() => ({
          address: ADDRESS.deposit,
          recipient: ADDRESS.wallet,
          expires_ledger: 8_496_182,
          expires_at: '2027-04-23T18:30:00.000Z',
          pending: '0',
          swept_total: USDC(2, 75),
          create_tx: 'ad82b35901c6c5dee76ac430edc32d19b6b7e1de3be01c2cca1c2c9ff2ea4473',
          register_tx: '3c2d253df23b2167716655fb87a3776bed00e4038b10b95684e2af3e49eeccaa',
          lock_tx: '0998d2f98263af425dd0338c0f1987a0154e95a8942843fb9d8e81fa48f4f36f',
          last_sweep_tx: '6509c22269a78b60c0776d43855db7d612f7b49030ce5bb8b4b55785caa67e68',
        })),
      }
    }),
  )

/** The fixture data, for tests and stories. */
export const fixture = { wallet, grants, pending, receipts, contacts, address: ADDRESS } as const
