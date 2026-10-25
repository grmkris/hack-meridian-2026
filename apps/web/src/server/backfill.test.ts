import { Effect, Layer, ManagedRuntime } from 'effect'
import { describe, expect, test } from 'vitest'

import { backfilledDb } from './backfill.ts'
import { Db, type SqlEngine, type SqlStatement } from './db.ts'
import { Network, type NetworkShape } from './network.ts'
import { first, sql } from './rows.ts'
import { testNetwork } from './test/layers.ts'
import { seedWallet, WALLET_ID } from './test/seed.ts'
import { sqliteEngine } from './test/sqlite.ts'

/**
 * The network backfill runs on the isolate's first query, not while the layer is built: the Worker builds it in global
 * scope, where D1 I/O is not allowed, and the backfill there failed quietly (mainnet rows kept stellar:testnet on
 * 9fc080f until fixed by hand). It runs once, then every query goes straight through.
 */

const PUBNET: NetworkShape = { ...testNetwork, name: 'pubnet', caip: 'stellar:pubnet', label: 'Mainnet' }

const recorded = (engine: SqlEngine, log: Array<string>): SqlEngine => ({
  all: statement => {
    log.push(statement.sql)
    return engine.all(statement)
  },
  batch: statements => {
    log.push(...statements.map((statement: SqlStatement) => statement.sql))
    return engine.batch(statements)
  },
})

const networkOf = (walletId: string) =>
  first(sql('SELECT network FROM wallets WHERE id = ?', walletId), row => Effect.succeed(String(row['network'])))

describe('the network backfill', () => {
  test('nothing runs while the layer is built; the first query backfills once, later queries do not', async () => {
    const engine = await sqliteEngine()
    // A wallet written before the column followed the stage: stellar:testnet on a pubnet stage.
    await ManagedRuntime.make(Db.fromEngine(engine)).runPromise(seedWallet())
    const log: Array<string> = []
    const runtime = ManagedRuntime.make(
      backfilledDb.pipe(
        Layer.provide(Db.fromEngine(recorded(engine, log))),
        Layer.provide(Layer.succeed(Network, PUBNET)),
      ),
    )
    try {
      await runtime.context()
      expect(log).toEqual([])

      expect(await runtime.runPromise(networkOf(WALLET_ID))).toBe('stellar:pubnet')
      const updates = () => log.filter(text => text.startsWith('UPDATE wallets SET network')).length
      expect(updates()).toBe(1)
      expect(log.filter(text => text.startsWith('UPDATE contact_destinations SET network'))).toHaveLength(1)

      await runtime.runPromise(networkOf(WALLET_ID))
      await runtime.runPromise(networkOf(WALLET_ID))
      expect(updates()).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })
})
